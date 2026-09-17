/**
 * vault 数据面 + 空间初始化。
 *
 * 单独成模块是为了让 `routes.ts` / 未来的工具层都能引到它，
 * 而不必反过来依赖插件入口（避免循环引用）。
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync, rmdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { countEntries } from './index-db.js';
import { ensureInstructionsFile, INSTRUCTIONS_FILE } from './instructions.js';
import { defaultProjectName, ensureProjectMeta, readProjectMeta } from './projects.js';
import {
  findProjectRootOrNull,
  indexDbPath,
  legacyPartitionsDir,
  memRoot,
  partitionDirFor,
  projectEntriesDir,
  projectEntryDir,
  projectKey,
  projectSharedDir,
  projectSpaceDir,
  sharedDir,
  spaceDir,
} from './paths.js';
import {
  parseSectionsYaml,
  seedLog,
  seedObservations,
  seedSectionFile,
  type SectionSpec,
} from './sections.js';
import { ensureVaultLayout, listVaultTree, readVaultFile, VAULT, walkMarkdown, writeVaultFile, type TreeNode } from './vault.js';

/**
 * vault 种类。**四种目录形态，但 UI 上只有三个 tab**：
 *
 *  - `shared`        **常驻记忆 + 全局共用**（身份/准则/能力/taste）→ 所有会话都注入
 *  - `chat`          **聊天记忆**
 *  - `project-space` **项目记忆**（容器：一个 `projects/` 目录 + 说明）
 *  - `project-entry` 某个项目自己的记忆（`projects/<项目名>/`）
 *
 * 项目记忆整体**不参与主动注入**，所以 `project-entry` 的 `resident` 不起作用。
 */
export type VaultKind = 'shared' | 'chat' | 'project-space' | 'project-entry';

/** 由构建产物位置定位随包发布的模板目录（`lib/templates/`）。 */
function loadTemplate(...parts: string[]): string | null {
  try {
    return readFileSync(new URL(`./templates/${parts.join('/')}`, import.meta.url), 'utf8');
  } catch {
    return null;
  }
}

export interface ResolvedMemConfig {
  enabled: boolean;
  home: string;
  projectRootMarkers: string[];
  promptLang: string;
  /** 单次记忆注入的字符预算（超出会截断）。 */
  injectMaxChars: number;
  /** 单次实体命中的字符预算（超出会截断）。 */
  entityMaxChars: number;
  /** 「用户明说记住」时的提醒（P4）。 */
  autoWrite: boolean;
  /** 原始轮次采集：给 dream 读的素材（P6 的前提）。 */
  captureTurns: boolean;
  /** dream（P6）：每晚统一整理。 */
  dream: boolean;
  /** 每晚什么时候检查（`HH:MM`）。 */
  dreamAt: string;
  /** 最近多少分钟有活动就推迟。 */
  dreamIdleMinutes: number;
  /** 成功后多久内不再跑。 */
  dreamCooldownHours: number;
  /** 项目时间线采集（P4.5）。 */
  timeline: boolean;
  /** `mem_diff` 单次返回的字符预算。 */
  diffMaxChars: number;
  /** RCC（聊天原文召回，§5.8）：把最近若干场里用户的全部发言带上，**只注入聊天空间**。 */
  rcc: boolean;
  /** RCC 覆盖多少场（计数单位是**场**，不是消息）。 */
  rccSessions: number;
  /** 单条用户发言保留的**头** N 字（超出掐中段）。 */
  rccHeadChars: number;
  /** 单条用户发言保留的**尾** N 字（超出掐中段）。 */
  rccTailChars: number;
  /** 一整场保留的**头** N 句（超出部分换成 `[TL;DR]` 标记；默认 12）。 */
  rccHeadTurns: number;
  /** 一整场保留的**尾** N 句（默认 0：整场只留开头那 12 句）。 */
  rccTailTurns: number;
  /** RCC 整块的字符预算；超出从最旧的场开始丢（安全网）。 */
  rccMaxChars: number;
  /** 补丁链路一轮最多补几段（默认 1：只补命中的那一轮原话）。 */
  rccPatchK: number;
  /** 单条补丁（= 一轮原话）的字符预算。 */
  rccPatchChars: number;
}

/**
 * 初始化一个 vault 目录：建标准子目录 + 按 sections.yaml 建分区文件。
 *
 * **只写不存在的文件** —— 用户已编辑过的内容绝不被覆盖。
 *
 * @returns 本次实际创建的文件相对路径
 */
/** vault 种类 → 模板目录（查表比嵌套三元清楚，也不会有缩进陷阱）。 */
const TEMPLATE_DIR: Record<VaultKind, string[]> = {
  shared: ['shared'],
  chat: ['chat'],
  'project-space': ['project', 'space'],
  'project-entry': ['project', 'entry'],
};

export function ensureSpaceVault(dir: string, kind: VaultKind): string[] {
  const tmpl = TEMPLATE_DIR[kind];

  const sectionsYaml = loadTemplate(...tmpl, VAULT.sectionsYaml);
  const readme = loadTemplate(...tmpl, VAULT.readme);
  const sections: SectionSpec[] = sectionsYaml ? parseSectionsYaml(sectionsYaml) : [];

  const seed: Record<string, string> = {};
  if (sectionsYaml) seed[VAULT.sectionsYaml] = sectionsYaml;
  if (readme) seed[VAULT.readme] = readme;
  seed[VAULT.observations] = seedObservations();
  seed[VAULT.log] = seedLog();

  if (kind === 'project-entry') {
    seed[VAULT.timelineSummary] = [
      '# 项目时间线',
      '',
      '每条一行摘要 + `[→ id]` 指针；完整改动在 `raw/timeline/`，按需取。',
      '',
      '由工具结果里的 diff 自动累积，不需要手写。',
      '',
      '---',
      '',
    ].join('\n');
  }

  // 分区文件由模板推导，让记忆空间一打开就是可读、自解释的。
  //
  // **必须跳过 timeline.md**：`sections.yaml` 把它也列成了一个 section，
  // 但它的骨架是时间线专用的（见上面），不能套 `seedSectionFile` 的通用占位符 ——
  // 那句"尚未有内容，dream 会在确证后填入"对时间线是**错的**（它由钩子自动累积，不归 dream 管）。
  // 顺序摆错就会被静默覆盖，实测在真实会话里踩到过。
  for (const s of sections) {
    if (kind === 'project-entry' && s.file === VAULT.timelineSummary) continue;
    seed[s.file] = seedSectionFile(s);
  }

  const created = ensureVaultLayout(dir, seed);

  // 常驻记忆文件（A 层）只在共享层存在
  if (kind === 'shared') {
    const before = existsSync(join(dir, INSTRUCTIONS_FILE));
    ensureInstructionsFile(dir);
    if (!before) created.push(INSTRUCTIONS_FILE);
  }

  return created;
}

/** 旧的「跨项目层」`spaces/project/_shared/` 的检测结果。 */
export interface LegacySharedReport {
  dir: string;
  exists: boolean;
  /** 除模板骨架外是否还有真实内容（有的话就不能默默不管）。 */
  hasContent: boolean;
}

/**
 * 检测旧的跨项目层目录。
 *
 * 它已经并入全局层（`shared/`），代码里不再读写它。
 * **不自动搬** —— 自动搬会在用户不知情时改动他的数据；
 * 但如果那里真有内容而没人提醒，就是静默遗弃。两害相权，选"喊一声"。
 */
/** 递归数**文件**（`listVaultTree` 会把目录也算成条目，不能直接看长度）。 */
function countFiles(nodes: readonly TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === 'file') n += 1;
    if (node.children !== undefined) n += countFiles(node.children);
  }
  return n;
}

export function detectLegacyShared(home: string): LegacySharedReport {
  const dir = projectSharedDir(home);
  if (!existsSync(dir)) return { dir, exists: false, hasContent: false };

  // 只看内容**真正会落到的地方**：raw/ 下的文件、observations.md 的条目、sections/*.md 的正文。
  // 两个已经踩过的假阳性都防在这里：
  //  ① 不看 README.md / log.md / sections.yaml —— 它们天生带大段说明文字；
  //  ② raw/ 要**数文件**而不是看 listVaultTree 的长度 —— 空目录（如 raw/timeline/）也算条目。
  const rawFiles = countFiles(listVaultTree(join(dir, VAULT.rawDir))) > 0;

  const obs = readVaultFile(dir, VAULT.observations) ?? '';
  const hasObservation = obs.split(/\r?\n/).some((l) => /^\s*[-*]\s+\S/.test(l));

  const hasSectionText = walkMarkdown(dir)
    .filter((rel) => rel.startsWith(`${VAULT.sectionsDir}/`))
    .some((rel) => {
      const t = readVaultFile(dir, rel) ?? '';
      const body = t
        .replace(/^#.*$/gm, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
      return body !== '' && !body.includes('尚未有内容');
    });

  return { dir, exists: true, hasContent: rawFiles || hasObservation || hasSectionText };
}

/**
 * 把旧的项目目录 `spaces/project/proj/<key>/` 搬到 `spaces/project/projects/<项目名>/`。
 *
 * 这是**纯位置搬家**（数据一字不改，只换成更可读的目录名），所以自动做。
 * 与 `_shared` 那种"内容语义变了"的情况不同 —— 那种只告警，让人自己决定。
 *
 * @returns 已搬动的项目名（没搬就是空数组）
 */
export function migrateLegacyProjectDirs(home: string): string[] {
  const legacyRoot = legacyPartitionsDir(home);
  if (!existsSync(legacyRoot)) return [];

  let keys: string[];
  try {
    keys = readdirSync(legacyRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const moved: string[] = [];
  for (const key of keys) {
    const src = join(legacyRoot, key);
    const name = readProjectMeta(src)?.name ?? defaultProjectName(key);
    const dst = projectEntryDir(home, key, name);
    if (existsSync(dst)) continue; // 目标已存在，不动它
    try {
      mkdirSync(dirname(dst), { recursive: true });
      renameSync(src, dst);
      moved.push(name);
    } catch {
      /* 搬不动就留着，下一次启动再试 */
    }
  }

  // 搬空了就把旧目录清掉（还有剩就留着，别删数据）
  try {
    if (readdirSync(legacyRoot).length === 0) rmdirSync(legacyRoot);
  } catch {
    /* 留着也无害 */
  }
  return moved;
}

export interface PartitionInfo {  /** 分区 key（由项目根路径推导，稳定标识）。 */
  key: string;
  /** 项目根路径。 */
  root: string;
  /** 人类可读的项目名（目录名就是它）。 */
  name: string;
  /** 项目记忆目录：`<home>/.dsh-mem/spaces/project/projects/<name>/`。 */
  dir: string;
  created: string[];
}

/**
 * 按 **key + 项目根**（而不是 cwd）准备项目记忆目录。
 *
 * 为什么不能都从 cwd 现推：判定可能来自**登记表**（显式压过仓库标记），
 * 那时项目根就是登记的那个路径，拿 cwd 重新找 `.git` 会算出另一个目录。
 * 调用方（注入/工具）手上已经有 `resolveWorkspace` 的结果，就该用它。
 */
export function ensureProjectEntry(
  home: string,
  key: string,
  root: string,
): { name: string; dir: string; created: string[] } {
  ensureSpaceVault(projectSpaceDir(home), 'project-space');
  const name = root ? basename(root.replace(/[\\/]+$/, '')) : defaultProjectName(key);
  const dir = projectEntryDir(home, key, name);
  const created = ensureSpaceVault(dir, 'project-entry');
  const meta = ensureProjectMeta(dir, key, root);
  return { name: meta.name, dir, created };
}

/**
 * 准备某个工作区的**项目记忆目录**（按需创建，不在启动时预建）。
 *
 * 先确保 ✅ **项目记忆**这个容器存在（`project-space`），
 * 再在它的 `projects/` 下建出这个项目自己的目录（`project-entry`）。
 */
export function ensureProjectPartition(
  home: string,
  cwd: string,
  markers: readonly string[],
): PartitionInfo {
  const p = partitionDirFor(home, cwd, markers);
  const e = ensureProjectEntry(home, p.key, p.root);
  return { key: p.key, root: p.root, name: e.name, dir: e.dir, created: e.created };
}

/**
 * 列出**已存在**的项目记忆目录。
 *
 * 返回的是目录名（= 项目名），不是分区 key —— UI 与文件系统都以人类可读的名称为准。
 */
export function listPartitionKeys(home: string): string[] {
  try {
    return readdirSync(projectEntriesDir(home), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** 列出项目记忆目录的完整路径。 */
export function projectEntryDirs(home: string): string[] {
  return listPartitionKeys(home).map((n) => join(projectEntriesDir(home), n));
}

export interface WorkspaceVault {
  kind: 'chat' | 'project';
  dir: string;
  /** 项目分区 key；聊天空间为 null。 */
  key: string | null;
  /** 项目名（目录名）；聊天空间为 null。 */
  name: string | null;
  /** 命中的项目根；聊天空间为 null。 */
  root: string | null;
  created: string[];
}

/**
 * 一个会话该往哪个空间写。
 *
 * 判据是**工作目录能不能向上找到项目根标记**（默认 `.git`）：
 * 命中 → 项目记忆里属于这个仓库的目录；没命中 → 聊天记忆。
 *
 * 这是"隔离靠硬代码"的落点：项目目录直接由 cwd 推导，调用方
 * **没有机会**把 A 仓库的记忆写进 B 仓库 —— 它连选都没得选。
 */
export function resolveWorkspaceKind(
  cwd: string | null,
  markers: readonly string[],
): { kind: 'chat' | 'project'; root: string | null; key: string | null } {
  if (cwd === null || cwd.length === 0) return { kind: 'chat', root: null, key: null };
  const root = findProjectRootOrNull(cwd, markers);
  if (root === null) return { kind: 'chat', root: null, key: null };
  return { kind: 'project', root, key: projectKey(root) };
}

/** 解析并**按需初始化**目标 vault（目录还不存在就用模板建起来）。 */
export function ensureWorkspaceVault(
  home: string,
  cwd: string | null,
  markers: readonly string[],
): WorkspaceVault {
  const r = resolveWorkspaceKind(cwd, markers);
  if (r.kind === 'chat') {
    const dir = spaceDir(home, 'chat');
    return { kind: 'chat', dir, key: null, name: null, root: null, created: ensureSpaceVault(dir, 'chat') };
  }
  const key = r.key ?? '';
  const name = r.root ? basename(r.root.replace(/[\\/]+$/, '')) : defaultProjectName(key);
  ensureSpaceVault(projectSpaceDir(home), 'project-space');
  const dir = projectEntryDir(home, key, name);
  const created = ensureSpaceVault(dir, 'project-entry');
  const meta = ensureProjectMeta(dir, key, r.root ?? '');
  return { kind: 'project', dir, key, name: meta.name, root: r.root, created };
}

export interface VaultOverview {
  home: string;
  memRoot: string;
  /** 常驻记忆 + 全局共用：所有会话都注入。 */
  shared: { dir: string; entries: number };
  /** 聊天记忆。 */
  chat: { dir: string; entries: number };
  /** 项目记忆（容器）。 */
  project: { dir: string; entries: number };
  /** 每个项目各自的记忆目录（不注入，按需取）。 */
  projects: Array<{ key: string; name: string; dir: string; entries: number }>;
  indexEntries: number;
}

/** 只读数据面：供记忆空间 UI 与后续工具层使用。 */
export interface VaultApi {
  home: string;
  memRoot: string;
  sharedDir: string;
  chatDir: string;
  /** 项目记忆容器（tab 就是它）。 */
  projectDir: string;
  overview(): VaultOverview;
  tree(dir: string): TreeNode[];
  read(dir: string, rel: string): string | null;
  write(dir: string, rel: string, text: string): boolean;
  ensureProjectPartition(cwd: string): PartitionInfo;
}

export function createVaultApi(
  config: ResolvedMemConfig,
  getIndex: () => DatabaseSync | null,
): VaultApi {
  const home = config.home;
  const root = memRoot(home);
  const sharedRootDir = sharedDir(home);
  const chatDir = spaceDir(home, 'chat');
  const projectDir = projectSpaceDir(home);

  const countTop = (dir: string): number => countFiles(listVaultTree(dir));

  return {
    home,
    memRoot: root,
    sharedDir: sharedRootDir,
    chatDir,
    projectDir,

    overview(): VaultOverview {
      const db = getIndex();
      return {
        home,
        memRoot: root,
        shared: { dir: sharedRootDir, entries: countTop(sharedRootDir) },
        chat: { dir: chatDir, entries: countTop(chatDir) },
        project: { dir: projectDir, entries: countTop(projectDir) },
        projects: listPartitionKeys(home).map((name) => {
          const dir = join(projectEntriesDir(home), name);
          return { key: readProjectMeta(dir)?.key ?? name, name, dir, entries: countTop(dir) };
        }),
        indexEntries: db ? countEntries(db) : 0,
      };
    },

    tree: (dir) => listVaultTree(dir),
    read: (dir, rel) => readVaultFile(dir, rel),
    write: (dir, rel, text) => writeVaultFile(dir, rel, text),
    ensureProjectPartition: (cwd) => ensureProjectPartition(home, cwd, config.projectRootMarkers),
  };
}

export { indexDbPath };
