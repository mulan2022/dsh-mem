/**
 * 派生索引：SQLite **只是 vault 的缓存**。
 *
 * 设计文档 §4.1：任何时候删掉 index.db 都不丢数据 —— 它是纯派生的。
 * 每个 vault 目录的 mtime 变化会在下次重建时增量或全量刷新对应条目。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { dedupeTurns, readTurnFile, turnFiles } from './turns.js';
import { readVaultFile, resolveInsideVault, walkMarkdown } from './vault.js';

export interface IndexedEntry {
  /** 全局唯一键：`space:project:rel`（见 `entryKey`）。 */
  path: string;
  /** vault 内相对路径（给人看、给工具用的那个）。 */
  rel: string;
  space: string;
  project: string | null;
  kind: string;
  name: string | null;
  status: string | null;
  body: string;
  /**
   * **文件真的 mtime**（毫秒）—— 不是"这次重建的时间"。
   *
   * ⚠️ 这里曾经写成 `Date.now()`，于是每条记忆的日期都显示成"今天"，
   * 拿它判断新旧完全没用（而检索面正要靠它显示日期）。现在从 `statSync` 取。
   */
  mtime: number;
}

export interface RebuildResult {
  indexed: number;
  removed: number;
  scanned: number;
}

/**
 * 索引结构版本。**不匹配就整表重建**，不写迁移脚本 ——
 * 这是派生索引，本来就可以随时删掉重建，为它维护迁移逻辑不划算。
 * 版本 2：`path` 从"vault 内相对路径"改成 `space:project:rel`
 * （相对路径当主键会让不同空间里的同名文件互相覆盖，实测过）。
 * 版本 3：新增 `turns`（消息原文）与 `sessions`（对话/场）两张表 ——
 * 设计文档 §5.8 的「索引三层」里的第二、三层。
 */
export const SCHEMA_VERSION = 3;

const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS idx_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idx_entries (
  path       TEXT PRIMARY KEY,
  rel        TEXT NOT NULL,
  space      TEXT NOT NULL,
  project    TEXT,
  kind       TEXT NOT NULL,
  name       TEXT,
  status     TEXT,
  body       TEXT NOT NULL,
  keywords   TEXT,
  importance INTEGER,
  embedding  BLOB,
  mtime      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_lookup ON idx_entries(space, project, kind);
CREATE INDEX IF NOT EXISTS idx_entries_name   ON idx_entries(name);

-- ── 消息原文（§5.8 索引三层的第二层）：**一行一轮** ──
-- 与 idx_entries 一样是**派生**的：可从 raw/turns/*.jsonl 完整重建。
-- 主键刻意用 (session, at) 而不是 (session, turn)：turn 取不到时是 NULL，
-- 而 SQLite 的复合主键**不拦 NULL** —— 拿它当键会静默放进重复行。
-- at 是 ISO 时间戳、每轮必写，天然唯一。
CREATE TABLE IF NOT EXISTS turns (
  session    TEXT NOT NULL,
  at         TEXT NOT NULL,
  turn       INTEGER,
  cwd        TEXT,
  space      TEXT NOT NULL,
  project    TEXT,
  user_text  TEXT NOT NULL,
  ai_compact TEXT NOT NULL,
  tools      TEXT,
  covered_by TEXT,
  PRIMARY KEY (session, at)
);
CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session, at);

-- ── 对话（场）级：RCC 的编排单位与截断状态（§5.8 第三层） ──
-- **不是纯派生的**：title 来自 dsh-session-title，in_rcc / rcc_truncated
-- 由 RCC 拼装时回写。所以版本升级**不重建它**。
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  title         TEXT,
  started_at    INTEGER,
  in_rcc        INTEGER NOT NULL DEFAULT 0,
  rcc_truncated INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * 索引条目的全局唯一键。
 *
 * **不能用 vault 内相对路径**：每个 vault 都有 `README.md`、`observations.md`、
 * `sections/*`，拿相对路径当主键，第二个 vault 一进来就把第一个的行覆盖掉
 * —— 实测「2 个 vault × 2 个同名文件」插 4 条只剩 2 行，而且是**静默**的。
 */
export function entryKey(space: string, project: string | null, rel: string): string {
  return project ? `${space}:${project}:${rel}` : `${space}:${rel}`;
}

export function openIndex(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(META_SCHEMA);

  const row = db.prepare('SELECT value FROM idx_meta WHERE key = ?').get('schema_version') as
    | { value?: string }
    | undefined;
  const found = row?.value === undefined ? 0 : Number(row.value);
  if (found !== SCHEMA_VERSION) {
    // 只丢**派生**表。`sessions` 不是派生的（title 来自 DSH、rcc 状态由拼装回写），
    // 所以版本升级不重建它。
    // 注意：`turns` 的 `project` / `covered_by` 两列是**回写**的状态、不是文件派生的。
    // 现在还没有人写它们；将来若写了，这里的 DROP 要改成"保列重建"。
    db.exec('DROP TABLE IF EXISTS idx_entries');
    db.exec('DROP TABLE IF EXISTS turns');
    db.exec(SCHEMA);
    db.prepare(
      'INSERT INTO idx_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('schema_version', String(SCHEMA_VERSION));
  } else {
    db.exec(SCHEMA);
  }
  return db;
}

/** 关闭并允许后续重开；幂等。 */
export function closeIndex(db: DatabaseSync | null): void {
  try {
    db?.close();
  } catch {
    /* 已关闭 */
  }
}

/**
 * 由路径推断条目种类。这是索引层唯一的"语义"判断，
 * 集中在此以便将来加新目录时只改一处。
 */
export function kindOf(rel: string): string {
  if (rel.startsWith('sections/')) return 'section';
  if (rel.startsWith('entities/')) return 'entity';
  if (rel === 'observations.md') return 'observ';
  if (rel === 'README.md') return 'readme';
  if (rel === 'index.md') return 'index';
  if (rel === 'log.md') return 'log';
  if (rel === 'timeline.md') return 'timeline';
  if (rel.startsWith('raw/')) return 'raw';
  return 'other';
}

/**
 * 解析文件头部的 front-matter 块：
 *
 * ```
 * ---
 * kind: concept
 * status: stuck
 * ---
 * ```
 *
 * 只支持扁平的 `key: value`。刻意不引 YAML 依赖 —— 我们自己的格式够简单，
 * 而引入完整 YAML 解析器只为了读几个标量不划算。
 */
export function parseFrontMatter(text: string): {
  attrs: Record<string, string>;
  body: string;
} {
  if (!text.startsWith('---')) return { attrs: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { attrs: {}, body: text };
  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const attrs: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    attrs[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { attrs, body };
}

/** 从内容中提取 `[[双链]]` 目标（图谱边）。 */
export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.add(m[1].trim());
  return [...out];
}

/**
 * 全量重建某个 vault 目录对应的索引条目。
 *
 * 策略：扫盘 → 逐文件 upsert → 删掉库中已不存在的 path。
 * 规模在几百个 markdown 文件量级，全量重建的成本远低于增量逻辑的维护成本。
 */
export function rebuildVault(
  db: DatabaseSync,
  vaultDir: string,
  space: string,
  project: string | null,
  opts: { skipDirs?: readonly string[] } = {},
): RebuildResult {
  const files = walkMarkdown(vaultDir, opts.skipDirs ?? ['raw']);
  const seen = new Set<string>();
  const now = Date.now();
  let indexed = 0;

  const upsert = db.prepare(`
    INSERT INTO idx_entries (path, rel, space, project, kind, name, status, body, keywords, importance, mtime, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      rel = excluded.rel,
      space = excluded.space,
      project = excluded.project,
      kind = excluded.kind,
      name = excluded.name,
      status = excluded.status,
      body = excluded.body,
      mtime = excluded.mtime,
      updated_at = excluded.updated_at
  `);

  for (const rel of files) {
    const text = readVaultFile(vaultDir, rel);
    if (text === null) continue;
    const { attrs, body } = parseFrontMatter(text);
    const kind = kindOf(rel);
    // 实体页/分区页的 name 是"精确命中入口"，所以优先取 front-matter 的 name，
    // 否则退回文件名（去掉 .md）
    const name = attrs.name ?? basename(rel).replace(/\.md$/, '');
    // **文件真的 mtime**，不是这次重建的时间 —— 检索面要靠它显示"这条记忆多旧"。
    // 取不到就退回 now（宁可显示今天，也不要因为一次 stat 失败就没有日期）。
    let mtime = now;
    const abs = resolveInsideVault(vaultDir, rel);
    if (abs !== null) {
      try {
        mtime = Math.floor(statSync(abs).mtimeMs);
      } catch {
        /* 文件刚被删 / 权限问题：退回 now */
      }
    }
    upsert.run(entryKey(space, project, rel), rel, space, project, kind, name, attrs.status ?? null, body, mtime, mtime);
    seen.add(rel);
    indexed++;
  }

  // 清理已不存在的条目（用户手删文件后索引不能留幽灵）。
  // **必须拿 `rel` 去比 `seen`**：`path` 是 `space:project:rel` 的复合键，
  // 拿它去比相对路径集合会永远不命中 —— 于是每次重建都把自己刚插的行全删掉，
  // 表现为"报告写入 N 条、库里 0 行"（这个坑真的踩过一次，冒烟测试抓到的）。
  const existing = db
    .prepare('SELECT path, rel FROM idx_entries WHERE space = ? AND (project IS ? OR project = ?)')
    .all(space, project, project) as Array<{ path: string; rel: string }>;
  const del = db.prepare('DELETE FROM idx_entries WHERE path = ?');
  let removed = 0;
  for (const row of existing) {
    if (!seen.has(row.rel)) {
      del.run(row.path);
      removed++;
    }
  }

  return { indexed, removed, scanned: files.length };
}

export function countEntries(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM idx_entries').get() as { n: number };
  return row.n;
}

/**
 * 读出全部条目（可选过滤）。
 *
 * 过滤放在 JS 里而不是拼 SQL：这个量级（几百条）全读回来再筛，
 * 比按调用方组合出 2^n 种 WHERE 子句好维护得多，也不会有参数绑定顺序的坑。
 */
export function listEntries(
  db: DatabaseSync,
  filter: { spaces?: readonly string[]; project?: string | null } = {},
): IndexedEntry[] {
  const rows = db
    .prepare('SELECT path, rel, space, project, kind, name, status, body, mtime FROM idx_entries')
    .all() as Array<{
    path: string;
    rel: string;
    space: string;
    project: string | null;
    kind: string;
    name: string | null;
    status: string | null;
    body: string;
    mtime: number;
  }>;

  let out: IndexedEntry[] = rows;
  if (filter.spaces !== undefined) {
    const allow = new Set(filter.spaces);
    out = out.filter((e) => allow.has(e.space));
  }
  if (filter.project !== undefined) {
    out = out.filter((e) => e.project === filter.project);
  }
  return out;
}

// ── 消息原文（turns）与对话（sessions） ──────────────────────────────────────
//
// 这两张表是 §5.8「索引三层」的第二、三层：
//   记忆       → idx_entries（一个 vault 文件一条）
//   消息原文   → turns      （一轮一条，RCC 的关键词匹配面）
//   对话（场） → sessions   （一场一条，RCC 的编排与截断判定）
//
// 建的是**表**，不是检索引擎 —— BM25 在这两张表上现算，不引倒排/向量索引。

export interface TurnRow {
  session: string;
  at: string;
  turn: number | null;
  cwd: string | null;
  space: string;
  project: string | null;
  userText: string;
  aiCompact: string;
  tools: string[];
  coveredBy: string | null;
}

export interface SessionRow {
  session: string;
  title: string | null;
  startedAt: number | null;
  inRcc: boolean;
  rccTruncated: boolean;
}

interface RawTurnRow {
  session: string;
  at: string;
  turn: number | null;
  cwd: string | null;
  space: string;
  project: string | null;
  user_text: string;
  ai_compact: string;
  tools: string | null;
  covered_by: string | null;
}

interface RawSessionRow {
  session_id: string;
  title: string | null;
  started_at: number | null;
  in_rcc: number;
  rcc_truncated: number;
}

function toTurnRow(r: RawTurnRow): TurnRow {
  let tools: string[] = [];
  try {
    const parsed = JSON.parse(r.tools ?? '[]') as unknown;
    if (Array.isArray(parsed)) tools = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    /* 坏 JSON 视为空 */
  }
  return {
    session: r.session,
    at: r.at,
    turn: r.turn,
    cwd: r.cwd,
    space: r.space,
    project: r.project,
    userText: r.user_text,
    aiCompact: r.ai_compact,
    tools,
    coveredBy: r.covered_by,
  };
}

function toSessionRow(r: RawSessionRow): SessionRow {
  return {
    session: r.session_id,
    title: r.title,
    startedAt: r.started_at,
    inRcc: r.in_rcc === 1,
    rccTruncated: r.rcc_truncated === 1,
  };
}

/**
 * 从 `raw/turns/*.jsonl` 重建 `turns`。
 *
 * **保列重建**：`project` 与 `covered_by` 是**回写**的状态、不是文件派生的
 * （归属由 dream 判、覆盖由 §5.7 递归压缩写），所以 upsert 时**不覆盖**它们；
 * 只有文件里已经不存在的 `(session, at)` 才删掉。
 * 直接 delete+insert 会把回写的状态抹掉 —— 那正是 §5.4 `superseded_by` 的那个坑。
 */
export function rebuildTurns(
  db: DatabaseSync,
  home: string,
): { indexed: number; removed: number; scanned: number } {
  const files = turnFiles(home);
  const kept = new Set<string>();
  const existing = new Set<string>();
  for (const r of db.prepare('SELECT session, at FROM turns').all() as Array<{
    session: string;
    at: string;
  }>) {
    existing.add(`${r.session}\u0000${r.at}`);
  }

  const upsert = db.prepare(`
    INSERT INTO turns (session, at, turn, cwd, space, project, user_text, ai_compact, tools, covered_by)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
    ON CONFLICT(session, at) DO UPDATE SET
      turn       = excluded.turn,
      cwd        = excluded.cwd,
      space      = excluded.space,
      user_text  = excluded.user_text,
      ai_compact = excluded.ai_compact,
      tools      = excluded.tools
  `);

  let indexed = 0;
  const firstSeen = new Map<string, number>();
  for (const abs of files) {
    // **同一个轮次号只留一份**：两条写入路径的 `at` 天然不同（写入时刻 vs 日志里的
    // turn/start 时刻），所以主键 `(session, at)` 挡不住"同一轮落两行"（实测踩过）。
    for (const rec of dedupeTurns(readTurnFile(abs))) {
      if (typeof rec.at !== 'string' || rec.at === '') continue;
      const key = `${rec.session}\u0000${rec.at}`;
      if (kept.has(key)) continue;
      kept.add(key);
      upsert.run(
        rec.session,
        rec.at,
        typeof rec.turn === 'number' ? rec.turn : null,
        rec.cwd ?? null,
        rec.space,
        rec.user ?? '',
        rec.assistant ?? '',
        JSON.stringify(Array.isArray(rec.tools) ? rec.tools : []),
      );
      indexed++;
      const ms = Date.parse(rec.at);
      if (Number.isFinite(ms)) {
        const prev = firstSeen.get(rec.session);
        if (prev === undefined || ms < prev) firstSeen.set(rec.session, ms);
      }
    }
  }

  const del = db.prepare('DELETE FROM turns WHERE session = ? AND at = ?');
  let removed = 0;
  for (const key of existing) {
    if (kept.has(key)) continue;
    const cut = key.indexOf('\u0000');
    del.run(key.slice(0, cut), key.slice(cut + 1));
    removed++;
  }

  // 素材里出现过的场都要有会话行（title 留给 dsh-session-title 补）。
  for (const [session, ms] of firstSeen) ensureSession(db, session, ms);

  // **反向**：没有任何轮次的会话行不该留着 —— 只被 `setRccState` 建过、随后素材被清掉的场
  // （比如"子代理会话误入素材"被清理之后）留着它，RCC 就会多出一个空场。
  db.prepare('DELETE FROM sessions WHERE session_id NOT IN (SELECT DISTINCT session FROM turns)').run();

  return { indexed, removed, scanned: files.length };
}

/** 建会话行（已存在则只补空的 `started_at`）。 */
export function ensureSession(
  db: DatabaseSync,
  session: string,
  startedAt: number | null = null,
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, started_at) VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET started_at = COALESCE(sessions.started_at, excluded.started_at)`,
  ).run(session, startedAt);
}

/** 读会话行（不存在返回 null）。 */
export function getSession(db: DatabaseSync, session: string): SessionRow | null {
  const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(session) as
    | RawSessionRow
    | undefined;
  return row === undefined ? null : toSessionRow(row);
}

/**
 * 回写 RCC 状态（§5.8）：拼完 RCC 后把「这一场在不在 RCC 里」「这一场被没被裁」
 * 写回表 —— 补丁链路**每轮要查它，不能每轮重算**：
 * RCC 是按 token 裁中段的，重放一遍不保证得到同样的切法。
 */
export function setRccState(
  db: DatabaseSync,
  sessionIds: readonly string[],
  state: { inRcc?: boolean; truncated?: boolean },
): number {
  const setIn = db.prepare('UPDATE sessions SET in_rcc = ? WHERE session_id = ?');
  const setTr = db.prepare('UPDATE sessions SET rcc_truncated = ? WHERE session_id = ?');
  let n = 0;
  for (const id of sessionIds) {
    ensureSession(db, id);
    if (state.inRcc !== undefined) n += Number(setIn.run(state.inRcc ? 1 : 0, id).changes);
    if (state.truncated !== undefined) n += Number(setTr.run(state.truncated ? 1 : 0, id).changes);
  }
  return n;
}

/**
 * 全部会话行，**按时间正序**（旧→新）。
 *
 * `started_at` 可能是 NULL（只被 `setRccState` 建过行、还没有轮次的场），
 * 排序时把它们放最后 —— 否则 NULL 在 SQLite 里排最前，会被当成"最旧"而被预算丢掉。
 */
export function listSessions(
  db: DatabaseSync,
  filter: { inRccOnly?: boolean; recent?: number } = {},
): SessionRow[] {
  const rows = db
    .prepare('SELECT * FROM sessions ORDER BY started_at IS NULL, started_at')
    .all() as unknown as RawSessionRow[];
  let out = rows.map(toSessionRow);
  if (filter.inRccOnly === true) out = out.filter((s) => s.inRcc);
  if (filter.recent !== undefined && filter.recent >= 0) out = out.slice(-filter.recent);
  return out;
}

/** 读出 RCC 覆盖的那些场，**按时间正序**（RCC 是"最近 40 场"的滚动窗口）。 */
export function listRccSessions(db: DatabaseSync, limit = 40): SessionRow[] {
  return listSessions(db, { inRccOnly: true }).slice(-Math.max(0, limit));
}

/** 读消息原文（可选按场过滤，按时间正序）。 */
export function listTurns(
  db: DatabaseSync,
  filter: { session?: string; limit?: number } = {},
): TurnRow[] {
  const rows =
    filter.session === undefined
      ? (db.prepare('SELECT * FROM turns ORDER BY at').all() as unknown as RawTurnRow[])
      : (db
          .prepare('SELECT * FROM turns WHERE session = ? ORDER BY at')
          .all(filter.session) as unknown as RawTurnRow[]);
  const out = rows.map(toTurnRow);
  return filter.limit === undefined ? out : out.slice(0, filter.limit);
}
