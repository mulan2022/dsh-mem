/**
 * 实体索引与匹配（设计文档 §5.2 主检索路径）。
 *
 * 检索不靠向量，靠**实体名精确命中**：
 *   用户消息 → 抽实体名 → 查 `entities/<name>.md` → 读该页 + 顺链一跳邻居
 *
 * 为什么这条路可行：vault 是**文档**而不是一堆原子事实。人（和 AI）提到某个
 * 项目/概念/人时，通常会说它的名字；名字命中就精确，不需要语义相似度去猜。
 * 向量只在"没说出实体名、而是描述性提问"时才需要（P8，且默认关）。
 *
 * 实体页格式：
 * ```
 * ---
 * name: 意识之镜
 * kind: concept         # person|project|concept|place|self
 * status: ongoing       # active|ongoing|stuck|abandoned|done
 * aliases: 意识镜, 镜子
 * ---
 * 正文…… [[相邻实体]]
 * ```
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { extractLinks, parseFrontMatter } from './index-db.js';
import { readVaultFile, VAULT } from './vault.js';

export interface EntityEntry {
  /** 实体名（精确命中的键）。 */
  name: string;
  /** vault 内相对路径，如 `entities/意识之镜.md`。 */
  path: string;
  kind: string;
  status: string;
  /** 别名，同样参与命中。 */
  aliases: string[];
  /** `[[双链]]` 指向的目标名（顺链一跳用）。 */
  links: string[];
  body: string;
  /** 所属 vault 的绝对路径 —— 多空间时用来回读邻居页。 */
  vaultDir: string;
}

/** 名字太短容易误命中（比如单字），低于此长度不作为命中键。 */
const MIN_NAME_LEN = 2;

/** 扫一个 vault 的 `entities/` 目录，建立实体条目。 */
export function scanEntities(vaultDir: string): EntityEntry[] {
  const dir = join(vaultDir, VAULT.entitiesDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }

  const out: EntityEntry[] = [];
  for (const file of names) {
    const rel = `${VAULT.entitiesDir}/${file}`;
    const raw = readVaultFile(vaultDir, rel);
    if (raw === null) continue;
    const { attrs, body } = parseFrontMatter(raw);
    const fallbackName = file.replace(/\.md$/, '');
    const name = (attrs.name || fallbackName).trim();
    if (!name) continue;
    const aliases = (attrs.aliases ?? '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= MIN_NAME_LEN);
    out.push({
      name,
      path: rel,
      kind: attrs.kind ?? 'unknown',
      status: attrs.status ?? 'active',
      aliases,
      links: extractLinks(body),
      body,
      vaultDir,
    });
  }
  return out;
}

/** 一个实体可用于命中的全部写法（主名 + 别名），都满足最小长度。 */
function keysOf(e: EntityEntry): string[] {
  return [e.name, ...e.aliases].filter((k) => k.length >= MIN_NAME_LEN);
}

/**
 * 在文本里找命中的实体。
 *
 * 用**子串命中**（中文没有词边界，`includes` 是唯一可靠的方式），
 * 并刻意限制最小长度以压低误命中。命中多个时按名字长度降序返回 ——
 * 长名更具体，优先给它。
 */
export function matchEntities(text: string, entries: readonly EntityEntry[]): EntityEntry[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const hit: EntityEntry[] = [];
  for (const e of entries) {
    for (const key of keysOf(e)) {
      if (lower.includes(key.toLowerCase())) {
        hit.push(e);
        break;
      }
    }
  }
  return hit.sort((a, b) => b.name.length - a.name.length);
}

/**
 * 顺链一跳：把命中实体的直接邻居也取回来。
 *
 * 只跳**一跳**，且只在邻居本身也是已知实体时才算 —— 否则
 * "提到攀岩项目就顺链摸到高斯泼溅"会一路扩散下去，把上下文吃光。
 *
 * @returns 邻居条目（已排除 `exclude` 里已有的）
 */
export function expandOneHop(
  matched: readonly EntityEntry[],
  all: readonly EntityEntry[],
  exclude: ReadonlySet<string> = new Set(),
): EntityEntry[] {
  const byName = new Map<string, EntityEntry>();
  for (const e of all) {
    byName.set(e.name, e);
    for (const a of e.aliases) byName.set(a, e);
  }

  const out: EntityEntry[] = [];
  const taken = new Set<string>([...exclude, ...matched.map((m) => m.name)]);
  for (const m of matched) {
    for (const target of m.links) {
      const e = byName.get(target);
      if (!e || taken.has(e.name)) continue;
      taken.add(e.name);
      out.push(e);
    }
  }
  return out;
}

/** 收集多个 vault 的实体，建一个可按名字查的索引。 */
export class EntityIndex {
  private entries: EntityEntry[] = [];
  private byName = new Map<string, EntityEntry>();
  private builtAt = 0;
  /** 按目录签名缓存的"额外来源"（P4.6：当前项目分区的实体）。 */
  private extras = new Map<string, { at: number; entries: EntityEntry[] }>();

  constructor(
    private readonly vaultDirs: readonly string[],
    /** 索引存活时间（毫秒）。实体由 dream 写入，不需要每次 pre-step 都扫盘。 */
    private readonly ttlMs = 30_000,
  ) {}

  /** 按需重建（TTL 内复用）。 */
  ensure(now = Date.now()): EntityEntry[] {
    // 纯 TTL 判断。刻意不加"entries 为空就重建"的短路 ——
    // 那会让"确实没有实体"的情况在每次 pre-step 都重扫盘。
    if (now - this.builtAt < this.ttlMs) return this.entries;
    return this.rebuild(now);
  }

  rebuild(now = Date.now()): EntityEntry[] {
    const all: EntityEntry[] = [];
    for (const dir of this.vaultDirs) all.push(...scanEntities(dir));
    this.entries = all;
    this.byName = new Map();
    for (const e of all) {
      this.byName.set(e.name, e);
      for (const a of e.aliases) this.byName.set(a, e);
    }
    this.builtAt = now;
    return all;
  }

  /**
   * 扫描**当前会话专属**的 vault（P4.6：当前项目分区的实体）。
   *
   * 为什么不直接加到构造参数里：那三个共享目录是固定的，而当前分区
   * 随会话变化 —— 每次换项目都重建整个索引不值得。
   * 按目录签名单独缓存，签名不变就复用。
   */
  private ensureExtras(dirs: readonly string[], now: number): EntityEntry[] {
    if (dirs.length === 0) return [];
    const sig = [...dirs].sort().join('\u0000');
    const cached = this.extras.get(sig);
    if (cached !== undefined && now - cached.at < this.ttlMs) return cached.entries;
    const entries: EntityEntry[] = [];
    for (const d of dirs) entries.push(...scanEntities(d));
    // 缓存条目数封顶：分区数量不该让这个 Map 无限长
    if (this.extras.size >= 8) this.extras.delete(this.extras.keys().next().value as string);
    this.extras.set(sig, { at: now, entries });
    return entries;
  }

  /** 全部实体（含可选的额外目录）。 */
  all(extraDirs: readonly string[] = []): EntityEntry[] {
    const base = this.ensure();
    const extra = this.ensureExtras(extraDirs, Date.now());
    if (extra.length === 0) return base;
    const seen = new Set(base.map((e) => `${e.vaultDir}\u0000${e.path}`));
    const merged = [...base];
    for (const e of extra) {
      const id = `${e.vaultDir}\u0000${e.path}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(e);
    }
    return merged;
  }

  /** 全部实体名（供调试/UI）。 */
  names(): string[] {
    return this.entries.map((e) => e.name);
  }

  /**
   * 命中实体 + 顺链一跳。
   *
   * @param extraDirs 本会话额外的 vault（当前项目分区）
   */
  resolve(text: string, extraDirs: readonly string[] = []): { hit: EntityEntry[]; neighbors: EntityEntry[] } {
    const all = this.all(extraDirs);
    const hit = matchEntities(text, all);
    const neighbors = expandOneHop(hit, all);
    return { hit, neighbors };
  }
}

/** 把实体条目渲染成注入用的文本块。 */
export function renderEntity(e: EntityEntry): string {
  const meta = [e.kind !== 'unknown' ? e.kind : '', e.status].filter(Boolean).join(' · ');
  const head = `### ${e.name}${meta ? `（${meta}）` : ''}`;
  return `${head}\n${e.body.trim()}`;
}

/**
 * 渲染**实体目录**（标题级，不含正文）。
 *
 * 这是"开局给个标题"的落点：会话开始时只告诉模型有哪些页可翻，
 * **正文一律按需取**（提到名字自动展开，或用 `mem_entity` 主动查阅）。
 * 照搬"文献综述看到引用再去翻原文"的思路 —— 目录便宜，正文贵。
 *
 * @param max 最多列多少条（超出只报数量，不铺开）
 */
export function renderCatalog(entries: readonly EntityEntry[], max = 40): string | null {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, max);
  const lines = shown.map((e) => {
    const meta = [e.kind !== 'unknown' ? e.kind : '', e.status].filter(Boolean).join(' · ');
    return `- ${e.name}${meta ? `（${meta}）` : ''}`;
  });
  const more = entries.length > shown.length ? `\n（另有 ${entries.length - shown.length} 个未列出）` : '';
  return `### 记忆空间里的实体（只列名字，正文按需取）\n${lines.join('\n')}${more}`;
}
