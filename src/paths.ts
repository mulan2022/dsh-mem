/**
 * 路径解析：dsh home → 记忆空间根 → 各空间 → 项目分区 key。
 *
 * 设计文档 §4.2.3：两个空间都不放在工作区目录下。
 * 工作区类型只决定"读/写哪一个单例"，不决定数据存放位置。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export type SpaceKind = 'shared' | 'chat' | 'project';

/**
 * 记忆空间根：`<dsh home>/.dsh-mem`
 * 与 dsh 的会话存储同级，便于"备份只需备一个目录"。
 */
export function memRoot(home: string): string {
  return join(home, '.dsh-mem');
}

export function spacesDir(home: string): string {
  return join(memRoot(home), 'spaces');
}

export function spaceDir(home: string, kind: SpaceKind): string {
  return join(spacesDir(home), kind);
}

/**
 * 【项目记忆】空间根：`spaces/project/`。
 *
 * 它是**一个**空间、**一个** UI 入口 —— 不是"每个项目一个 tab"。
 * 每个项目的记忆是它下面的一个子目录（见 `projectEntriesDir`）。
 */
export function projectSpaceDir(home: string): string {
  return spaceDir(home, 'project');
}

/**
 * 项目记忆里的 `projects/`：**每个项目一个目录**。
 *
 * 名字就叫 `projects`（原先这里叫 `entities`）—— 因为它装的就是"有哪些项目"，
 * 而不是"某个项目里的实体"。实体是**项目内部**的概念，归各自的子目录管。
 */
export function projectEntriesDir(home: string): string {
  return join(projectSpaceDir(home), 'projects');
}

/** 目录名安全化：一个项目名不该带路径分隔符或 Windows 非法字符。 */
export function safeEntryName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^\.+/, '')
    .trim();
  return cleaned !== '' ? cleaned : 'project';
}

/**
 * 项目记忆的目录名 → 实际路径。
 *
 * 用**人类可读的项目名**当目录名（`projects/MemoryChat/`），而不是分区 key
 * （`d--demo-MemoryChat`）—— 用户要能在文件管理器里一眼看出哪个是哪个。
 * 两个不同项目同名时，后者带一段 key 的短哈希（确定性，不会每次换个名字）。
 */
export function projectEntryDir(home: string, key: string, name: string): string {
  const base = safeEntryName(name);
  const entries = projectEntriesDir(home);
  const direct = join(entries, base);
  const owner = readMetaKey(direct);
  if (owner === null || owner === key) return direct;
  return join(entries, `${base}-${shortHash(key)}`);
}

/**
 * key 的短哈希（FNV-1a 32 位 → base36）。
 *
 * **旧实现取的是 key 的末 6 位**（`key.replace(/[^A-Za-z0-9]/g,'').slice(-6)`），
 * 注释还写着"短哈希"—— 其实不是，而且有两个后果：
 *  1. 路径型 key 的末几位**几乎总是项目名本身**（`D--demo-MemoryChat` → `ryChat`），
 *     目录名变成 `MemoryChat-ryChat`，既难看又看不出在区分什么；
 *  2. **两个同名项目会算出同一个后缀** —— 它根本去不了重。
 */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, '0').slice(-6);
}

/** 读某个项目目录的 `meta.yaml` 里的 key（读不到返回 null）。 */
function readMetaKey(dir: string): string | null {
  try {
    const text = readFileSync(join(dir, 'meta.yaml'), 'utf8');
    const m = /^key\s*:\s*(.+)$/m.exec(text);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

/** 共享身份层：`<home>/.dsh-mem/shared/` —— 【常驻记忆 + 全局共用】，所有会话都注入。 */
export function sharedDir(home: string): string {
  return join(memRoot(home), 'shared');
}

/**
 * @deprecated 已退役的「跨项目层」`spaces/project/_shared/`。
 * 只留给迁移检测用（`detectLegacyShared`），新代码不要再读写它。
 */
export function projectSharedDir(home: string): string {
  return join(spaceDir(home, 'project'), '_shared');
}

/**
 * @deprecated 已退役的分区根 `spaces/project/proj/`。
 * 现在是 `spaces/project/projects/`（见 `projectEntriesDir`），只留给迁移检测用。
 */
export function legacyPartitionsDir(home: string): string {
  return join(spaceDir(home, 'project'), 'proj');
}

/** 派生索引（可删，可重建） */
export function indexDbPath(home: string): string {
  return join(memRoot(home), 'index.db');
}

/** 工作区类型登记表 */
export function workspacesYamlPath(home: string): string {
  return join(memRoot(home), 'workspaces.yaml');
}

/**
 * **未归属的原始素材**：`<home>/.dsh-mem/raw/`。
 *
 * 刻意放在 `shared/` 与 `spaces/` **之外** —— 它既不是全局记忆、也不是某个空间的记忆，
 * 而是"还没判断归属"的原始轮次。
 *
 * **为什么不按 cwd 分到各空间的 `raw/` 下**：那样等于**替 agent 把归属判完了**。
 * DSH 不支持给项目文件夹打 tag，归属只能靠内容判断 ——
 * 所以素材必须先中立地攒着，由 dream 派出的两个 agent 各自来认领。
 */
export function rawMaterialDir(home: string): string {
  return join(memRoot(home), 'raw');
}

/** 原始轮次：`<home>/.dsh-mem/raw/turns/`，一个会话一个 jsonl。 */
export function turnsDir(home: string): string {
  return join(rawMaterialDir(home), 'turns');
}

/**
 * **DSH 自己的**会话日志根：`<dsh home>/sessions/`。
 *
 * 那里的东西是**官方归档**，不是我们的 —— 我们只读（§5.9 的"按指针取回"）。
 */
export function sessionsRootDir(home: string): string {
  return join(home, 'sessions');
}

/**
 * 历史回填的账本：`<会话 id> → 上次处理时官方日志的字节数`。
 *
 * 放插件状态那一层（与 `state.json` 同级），不放 `raw/` —— 它不是素材，是账本；
 * 丢了只是下次启动重扫一遍。
 */
export function historyStatePath(home: string): string {
  return join(memRoot(home), 'history-state.json');
}

/**
 * 规范化工作区路径：统一为正斜杠，**保留盘符大小写**（人类可读）。
 *
 * ⚠️ 这是**显示**用的形态。要拿路径当身份（分区 key、登记表键），用下面的
 * `identityPath` —— 两者刻意分开，理由见它的注释。
 */
export function normalizeWorkspacePath(p: string): string {
  return resolve(p).replace(/\\/g, '/');
}

/**
 * 「身份」用的路径归一：正斜杠 + **盘符小写**。
 *
 * **同一目录必须只有一个身份。** Windows 路径大小写不敏感，`D:\x` 与 `d:\x`
 * 是同一个目录，但 `path.resolve` 会**原样保留输入里的盘符大小写** —— 于是同一个
 * 项目会算出两个 key、切成两个分区。本机真机踩过：`D--demo-MemoryChat` 与
 * `d--demo-MemoryChat` 各自建了一个分区目录，项目记忆被劈成两半。
 *
 * 只小写盘符、不整条小写：整条小写会在 Linux 上把两个只差大小写的目录**悄悄并成一个**
 * —— 静默合并比不匹配更糟。
 *
 * 分区 key 与登记表键**都走这一份**：以前是两处各写一遍（`projectKey` 没小写、
 * `workspaces.registryKey` 小写了），正是那处不一致导致了上面的分叉。
 */
export function identityPath(p: string): string {
  return normalizeWorkspacePath(p).replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`);
}

/**
 * 向上查找项目根标记（默认 `.git`）。
 * 一个仓库 = 一个项目 —— 在仓库子目录里开会话归到仓库根的分区，
 * 不会因为换个子目录就换记忆。
 *
 * @returns 命中的标记目录；都没命中则回退到 `cwd` 本身。
 */
export function findProjectRoot(cwd: string, markers: readonly string[]): string {
  return findProjectRootOrNull(cwd, markers) ?? resolve(cwd);
}

/**
 * 向上查找项目根标记，**命中不了就返回 null**。
 *
 * 与 `findProjectRoot` 的区别是"没命中"这件事能不能被区分出来 ——
 * 自动写入要靠它决定内容落进聊天空间还是项目分区，
 * 而 `findProjectRoot` 把"没命中"伪装成了"cwd 就是项目根"，
 * 于是在非仓库目录里工作也会被当成一个项目。
 */
export function findProjectRootOrNull(cwd: string, markers: readonly string[]): string | null {
  const start = resolve(cwd);
  let dir = start;
  for (;;) {
    for (const m of markers) {
      if (m && existsSync(join(dir, m))) return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return null; // 到文件系统根仍未命中
    dir = parent;
  }
}

/**
 * 路径 → 分区目录名。
 * 每个 `:` `/` `\` 各自换成 `-`（不是合并成一段），
 * 于是 `D:\demo\MemoryChat` → `D--demo-MemoryChat`。
 */
export function projectKey(root: string): string {
  return identityPath(root)
    .replace(/[:/\\]/g, '-')
    .replace(/-{3,}/g, '--')
    .replace(/^-+|-+$/g, '');
}

/** 计算某个工作区会话应当使用哪个**项目记忆目录**。 */
export function partitionDirFor(
  home: string,
  cwd: string,
  markers: readonly string[],
): { key: string; root: string; name: string; dir: string } {
  const root = findProjectRoot(cwd, markers);
  const key = projectKey(root);
  const name = basename(root.replace(/[\\/]+$/, '')) || key;
  return { key, root, name, dir: projectEntryDir(home, key, name) };
}
