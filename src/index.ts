/**
 * dsh-mem —— 基于 vault 的 DSH 记忆空间插件（宿主端入口）。
 *
 * 设计文档：DESIGN-memory-plugin.md（设计资料，**不随仓库分发**）。
 *
 * 已完成：
 *  P0/P1    vault 目录约定 + 派生索引 + 数据面路由 + 记忆空间 UI
 *  P1.5     常驻记忆 A 层（工具唯一写入，上限 50）
 *  P2       注入（静态手册 + 常驻记忆，每会话一次，压缩后重注）
 *  P3       实体三档信息量（开局给名字目录 → 按需翻正文 → 双链可点击）
 *  P4       自动写入（v11 收窄：只剩「用户明说记住」提醒 + 原始轮次采集）
 *  P4.5     项目时间线（tools/result 抄 diff → 一轮一行摘要 + 详情按需取）
 *  P4.6     分区隔离与跨项目检索（登记表 → 仓库标记 → default）
 *  空间收敛  跨项目层并入 shared；**项目记忆整体不注入**（v10）
 *  分空间    聊天 / 项目按 agent preset 判定（§4.2.7，preset 压过登记表）
 *  RCC      聊天原文召回 + 补丁（§5.8）；原文归档与按指针取回（§5.9）
 *  P6       dream 调度内核 + 两段式编排 + `mem_dream` 工具
 *
 * 尚未实现：P6 的每晚定时路径与会话右键菜单「跳过整理」、P5 40 轮窗口铁律、
 * P7 三层晋升与冲突规则、P8 递归压缩、P9 锚点重访、P-1 检索测评集。
 * 已知缺口：项目分区的实体页进不了 `mem_entity` 的索引（见下方实体索引装配处）。
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { EntityIndex } from './entities.js';
import { closeIndex, listEntries, listSessions, openIndex, rebuildTurns, rebuildVault, setRccState } from './index-db.js';
import { backfillRawTurns } from './history.js';
import { buildRcc, patchCandidates } from './rcc.js';
import { installInjection, type InjectionLayer } from './inject.js';
import {
  indexDbPath,
  memRoot,
  normalizeWorkspacePath,
  projectEntriesDir,
  projectKey,
  projectSpaceDir,
  sharedDir,
  spaceDir,
  workspacesYamlPath,
} from './paths.js';
import { listProjectBriefs, mentionedProjects, renderPointers } from './projects.js';
import { installAutoWrite } from './reflect.js';
import { registerVaultRoutes } from './routes.js';
import { searchEntries, type SearchHit } from './search.js';
import { installTimeline } from './timeline.js';
import { installTurnCapture } from './turns.js';
import { runDream } from './dream-run.js';
import { dreamTool } from './tool-dream.js';
import { listPendingSessions, readDreamSkip, setDreamSkip } from './dream.js';
import { readState } from './state.js';
import { registerMemTools, type ObserveSpace } from './tools.js';
import {
  createVaultApi,
  detectLegacyShared,
  ensureProjectEntry,
  ensureSpaceVault,
  listPartitionKeys,
  migrateLegacyProjectDirs,
  projectEntryDirs,
  rolloverMonthSections,
  type ResolvedMemConfig,
} from './vault-api.js';
import { installDream, parseClock } from './dream.js';
import { resolveWorkspace, wasAsked, markAsked, ensureRegistryFile, readRegistry } from './workspaces.js';

export const name = 'dsh-mem';

/**
 * 读随包发布的提示词模板：`<包根>/prompts/<name>.md`。
 *
 * 从 `lib/index.js` 出发是 `../prompts/` —— 提示词**外置**是为了用户能直接改文案，
 * 不用重新构建（他要审的是文案，不是实现）。
 * 文件缺失时返回空串：编排层会照常把"路标"部分发出去，agent 至少知道该干什么。
 */
function loadPrompt(promptName: string): string {
  try {
    return readFileSync(new URL(`../prompts/${promptName}.md`, import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

/** 需要宿主的工具注册表 —— 常驻记忆的写入路径靠它（UI 只读，没有写接口）。 */
export const inject: string[] = ['tools', 'systemPrompt'];

export const Config = z.object({
  /** 总开关。关闭时停止全部读取与写入，但**不删除任何 vault 文件**。 */
  enabled: z.boolean().default(true),
  /** dsh home 覆盖；空串表示按 DSH_HOME → ~/.dsh 顺序解析。 */
  home: z.string().default(''),
  /** 项目根标记：命中即视为"一个项目"。沿用官方默认值。 */
  projectRootMarkers: z.array(z.string()).default(['.git']),
  /** 注入与工具文案语言（P2 起生效）。 */
  promptLang: z.string().default('zh'),
  /**
   * 单次记忆注入的字符预算（超出截断）。
   *
   * 8000 是按**随包发布的聊天模板**定的：六个常驻 section（个人背景 / 工作背景 /
   * 本月 / 早期月份 / 品味与偏好 / 记忆提示）填满后约 5000 字，留一半余量给常驻记忆
   * 与实体目录。默认若还是 2000，新装的人一上来就会被截掉一半。
   */
  injectMaxChars: z.number().min(0).default(8000),
  /** 单次实体命中的字符预算（超出截断）。 */
  entityMaxChars: z.number().min(0).default(3000),
  /** 「用户明说记住」时的提醒（P4）。关掉就不再 steer 反思消息。 */
  autoWrite: z.boolean().default(true),
  /**
   * 原始轮次采集（P6 的前提）：把每轮对话原文追加进 `raw/turns/<会话>.jsonl`，
   * 给晚上跑的 dream 读。**不调模型、不 steer**，只是存素材。
   */
  captureTurns: z.boolean().default(true),
  /** dream（P6）：每晚统一整理。 */
  dream: z.boolean().default(true),
  /** 每晚什么时候检查（`HH:MM`，本地时间）。 */
  dreamAt: z.string().default('03:00'),
  /** 最近多少分钟有活动就推迟。 */
  dreamIdleMinutes: z.number().min(0).default(15),
  /** 成功后多久内不再跑（防重复烧钱）。 */
  dreamCooldownHours: z.number().min(0).default(6),
  /** 项目时间线（P4.5）：把 write/edit 的 diff 记成"一轮一行摘要 + 详情按需取"。 */
  timeline: z.boolean().default(true),
  /** `mem_diff` 单次返回的字符预算。 */
  diffMaxChars: z.number().min(0).default(6000),
  /**
   * RCC（聊天原文召回，§5.8）：把最近若干场会话里**用户的全部发言**逐字带上。
   * **只注入聊天空间** —— 项目空间已经有"时间线摘要常驻 + 详情按需取"，再挂一套是重复。
   */
  rcc: z.boolean().default(true),
  /**
   * RCC 覆盖多少场（计数单位是**场**，不是消息）。
   *
   * **40 场之所以放得下，靠的是整场截断**（见 `rccHeadTurns` / `rccTailTurns`）：
   * 一场 100 轮也只留 12 句 ≈ 360 字，40 场 ≈ 1.4 万字 ≈ 8–14k token。
   * 用户 2026-09-15 调研 Kimi 回来确认：「它那边不仅有用户一条对话过长截断机制，
   * 还有**整场截断**机制，只保留 12 句剩下的全没了……怪不得能保留 40 场」。
   * （Kimi 砍掉就没了；我们砍掉的部分**有补丁能补回来**。）
   */
  rccSessions: z.number().min(0).default(40),
  /** 单条用户发言保留的**头** N 字（超出掐中段）。 */
  rccHeadChars: z.number().min(0).default(60),
  /** 单条用户发言保留的**尾** N 字（超出掐中段）。 */
  rccTailChars: z.number().min(0).default(40),
  /** 一整场保留的**头** N 句（超出部分换成 `[TL;DR]` 标记；默认 12）。 */
  rccHeadTurns: z.number().min(0).default(12),
  /** 一整场保留的**尾** N 句（默认 **0**：整场只留开头那 12 句，见 `rccHeadTurns`）。 */
  rccTailTurns: z.number().min(0).default(0),
  /** RCC 整块的字符预算；超出从最旧的场开始丢（安全网，正常不该触发）。 */
  rccMaxChars: z.number().min(0).default(40000),
  /**
   * 补丁链路一轮最多补几段（默认 **1** —— 用户 2026-09-17：「是触发关键词的那**一个**
   * 对话」，一轮一条就够；它落在同一场被砍的中段里命中好几轮时才可能用得上 2）。
   */
  rccPatchK: z.number().min(0).default(1),
  /** 单条补丁（= 一轮原话）的字符预算（兜底用；一轮正常远小于它）。 */
  rccPatchChars: z.number().min(0).default(4000),
});

/**
 * 解析外来 config。
 *
 * `apply` 收到的是 `unknown`（装配层不保证类型），所以逐字段兜底；
 * 任何字段缺失都不能让插件抛异常。
 * 特别地 `null` 当作"没有配置"—— settings.yaml 的空段会解析成 null，
 * 参考实现曾因此让 `Object.entries(null)` 抛异常、插件整块不启动。
 */
export function resolveConfig(raw: unknown): ResolvedMemConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const markers = Array.isArray(o.projectRootMarkers)
    ? o.projectRootMarkers.filter((m): m is string => typeof m === 'string' && m.length > 0)
    : [];
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    home: typeof o.home === 'string' ? o.home : '',
    projectRootMarkers: markers.length ? markers : ['.git'],
    promptLang: typeof o.promptLang === 'string' && o.promptLang ? o.promptLang : 'zh',
    injectMaxChars:
      typeof o.injectMaxChars === 'number' && Number.isFinite(o.injectMaxChars) && o.injectMaxChars >= 0
        ? o.injectMaxChars
        : 8000,
    entityMaxChars:
      typeof o.entityMaxChars === 'number' && Number.isFinite(o.entityMaxChars) && o.entityMaxChars >= 0
        ? o.entityMaxChars
        : 3000,
    autoWrite: typeof o.autoWrite === 'boolean' ? o.autoWrite : true,
    captureTurns: typeof o.captureTurns === 'boolean' ? o.captureTurns : true,
    dream: typeof o.dream === 'boolean' ? o.dream : true,
    dreamAt: typeof o.dreamAt === 'string' && parseClock(o.dreamAt) !== null ? o.dreamAt : '03:00',
    dreamIdleMinutes:
      typeof o.dreamIdleMinutes === 'number' && Number.isFinite(o.dreamIdleMinutes) && o.dreamIdleMinutes >= 0
        ? o.dreamIdleMinutes
        : 15,
    dreamCooldownHours:
      typeof o.dreamCooldownHours === 'number' &&
      Number.isFinite(o.dreamCooldownHours) &&
      o.dreamCooldownHours >= 0
        ? o.dreamCooldownHours
        : 6,
    timeline: typeof o.timeline === 'boolean' ? o.timeline : true,
    diffMaxChars:
      typeof o.diffMaxChars === 'number' && Number.isFinite(o.diffMaxChars) && o.diffMaxChars >= 0
        ? o.diffMaxChars
        : 6000,
    rcc: typeof o.rcc === 'boolean' ? o.rcc : true,
    rccSessions: nonNeg(o.rccSessions, 40),
    rccHeadChars: nonNeg(o.rccHeadChars, 60),
    rccTailChars: nonNeg(o.rccTailChars, 40),
    rccHeadTurns: nonNeg(o.rccHeadTurns, 12),
    rccTailTurns: nonNeg(o.rccTailTurns, 0),
    rccMaxChars: nonNeg(o.rccMaxChars, 40000),
    rccPatchK: nonNeg(o.rccPatchK, 1),
    rccPatchChars: nonNeg(o.rccPatchChars, 4000),
  };
}

/** 正整数字段兜底：非有限值或 <1 一律回退到默认。 */
function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

/** 非负数字段兜底（**0 合法** —— 预算类字段用它）。 */
function nonNeg(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function resolveHome(config: { home?: string }): string {
  if (config.home) return config.home;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return join(homedir(), '.dsh');
}

// 对外暴露数据面与空间初始化，供测试、宿主侧调用者与后续工具层使用
export {
  createVaultApi,
  detectLegacyShared,
  ensureProjectEntry,
  ensureProjectPartition,
  ensureSpaceVault,
  ensureWorkspaceVault,
  listPartitionKeys,
  migrateLegacyProjectDirs,
  projectEntryDirs,
  rolloverMonthSections,
  resolveWorkspaceKind,
  type LegacySharedReport,
  type PartitionInfo,
  type ResolvedMemConfig,
  type VaultApi,
  type VaultKind,
  type VaultOverview,
  type WorkspaceVault,
} from './vault-api.js';
export { registerVaultRoutes, resolveSpaceDir } from './routes.js';
export { buildExtractPrompt, buildMergePrompt } from './dream-run.js';
export {
  COMPACT_MAX_CHARS,
  compactPath,
  listCompacts,
  maxTurnOf,
  readCompact,
  windowPath,
  writeCompact,
  writeTurnWindow,
  type SessionCompact,
  type TurnWindow,
} from './compacts.js';
export { attachmentObjectPath } from './paths.js';
export { parseSectionsYaml, rolloverMonths, type MonthRolloverResult } from './sections.js';
export { identityPath, normalizeWorkspacePath, projectEntryDir, projectKey } from './paths.js';
export { MAX_INSTRUCTIONS, addInstruction, readInstructions, removeInstruction } from './instructions.js';
export {
  registerMemTools,
  snapshot,
  describeResolution,
  DEFAULT_DIFF_MAX_CHARS,
  TOOL_DIFF,
  TOOL_ENTITY,
  TOOL_FORGET,
  TOOL_OBSERVE,
  TOOL_REMEMBER,
  TOOL_SEARCH,
  TOOL_SPACE,
  type ObserveSpace,
  type ToolContext,
} from './tools.js';
export { closeIndex, countEntries, entryKey, listEntries, openIndex, rebuildVault, SCHEMA_VERSION } from './index-db.js';
export {
  ensureSession,
  getSession,
  listRccSessions,
  listSessions,
  listTurns,
  rebuildTurns,
  setRccState,
  type SessionRow,
  type TurnRow,
} from './index-db.js';
export {
  backfillRawTurns,
  decodeZstdFrames,
  findSessionLog,
  listSessionLogs,
  readSessionEvents,
  recallTurn,
  turnSlices,
  type BackfillReport,
  type RecallResult,
  type SessionLog,
} from './history.js';
export {
  labelOf,
  renderHits,
  searchEntries,
  snippetOf,
  tokenize,
  type SearchHit,
  type SearchOptions,
} from './search.js';
export {
  EMPTY_REGISTRY,
  ensureRegistryFile,
  markAsked,
  matchRegistered,
  parseRegistry,
  readRegistry,
  registryKey,
  removeWorkspace,
  renderRegistry,
  resolveWorkspace,
  setWorkspaceKind,
  wasAsked,
  writeRegistry,
  type DefaultPolicy,
  type WorkspaceKind,
  type WorkspaceRegistry,
  type WorkspaceResolution,
} from './workspaces.js';
export {
  META_FILE,
  defaultProjectName,
  ensureProjectMeta,
  listProjectBriefs,
  mentionedProjects,
  readProjectMeta,
  renderPointers,
  type ProjectBrief,
  type ProjectMeta,
} from './projects.js';
export {
  MUTATING_TOOLS,
  appendTimelineEntry,
  detailPath,
  installTimeline,
  readTimeline,
  renderDetail,
  seedTimeline,
  shortPath,
  summarizeEntry,
  validateDiffs,
  type CapturedDiff,
  type TimelineInput,
} from './timeline.js';
export { fenced, insertUnderDate, localDate, localStamp } from './markdown.js';
export {
  ANCHORS_FILE,
  appendAnchor,
  detailPathFor,
  findAnchor,
  parseAnchorMarkers,
  readAnchors,
  renderAnchorMarker,
  renderPointerMarker,
  stripAnchorMarkers,
  type Anchor,
} from './anchors.js';
export {
  appendObservation,
  precheckObservation,
  readObservations,
  type Observation,
} from './observations.js';
export {
  REFLECT_MARKER,
  buildReflectMessage,
  buildReflectPrompt,
  installAutoWrite,
  scanTurn,
  shouldReflect,
  WRITE_TOOLS,
  type TurnScan,
} from './reflect.js';
export {
  TURNS_DIR,
  TURN_TEXT_MAX,
  appendTurn,
  collectTurn,
  installTurnCapture,
  readTurns,
  type TurnRecord,
} from './turns.js';
export {
  LEASE_MINUTES,
  acquireLease,
  installDream,
  isDue,
  isIdle,
  judge,
  leaseHeld,
  listPendingSessions,
  parseClock,
  readDreamSkip,
  recordFailure,
  recordSuccess,
  releaseLease,
  setDreamSkip,
  type DreamOutcome,
  type DreamVerdict,
} from './dream.js';
export { EMPTY_STATE, readState, statePath, updateState, type PluginState } from './state.js';
export {
  dedupeObservations,
  extractJson,
  groupBySpace,
  missingAnchors,
  renderTemplate,
  validateExtract,
  type ExtractObservation,
  type ExtractResult,
  type ValidateReport,
} from './dream-json.js';
export {
  attachmentsOfUserMessage,
  currentTurnOf,
  isSubagentSession,
  sessionCwdOf,
  sessionEventsOf,
  sessionIdOf,
} from './session.js';
export {
  buildGuide,
  buildInjection,
  buildEntityInjection,
  createInjectionMessage,
  createNoticeMessage,
  createRecallMessage,
  installInjection,
  readResidentSections,
  resetInjectionState,
  textOfMessage,
  GUIDE_SECTION_NAME,
  type InjectionLayer,
  type RccHooks,
} from './inject.js';
export {
  DEFAULT_CUT,
  DEFAULT_HEAD,
  DEFAULT_HEAD_TURNS,
  DEFAULT_TAIL,
  DEFAULT_TAIL_TURNS,
  NO_CUT,
  PATCH_GENERIC_DF_RATIO,
  PATCH_GENERIC_MIN_DF,
  RCC_HEADER,
  RCC_SEP,
  RCC_TRUNCATED,
  buildRcc,
  cutMiddle,
  distinctiveTokens,
  foldContained,
  isPrefixOf,
  patchCandidates,
  rankTurns,
  renderPatch,
  sessionStamp,
  sessionTitle,
  sessionUserText,
  type CutOptions,
  type RccBuildResult,
  type RccPatch,
} from './rcc.js';
export {
  EntityIndex,
  expandOneHop,
  matchEntities,
  renderCatalog,
  renderEntity,
  scanEntities,
  type EntityEntry,
} from './entities.js';

/**
 * 插件入口。签名与参考实现一致：async，config 为 unknown。
 */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  const config = resolveConfig(rawConfig);
  const home = config.home || resolveHome({ home: '' });
  const resolved: ResolvedMemConfig = { ...config, home };
  const root = memRoot(home);

  if (!resolved.enabled) {
    ctx.logger.info(`dsh-mem: 已禁用，跳过 vault 初始化（root=${root}）`);
    return;
  }

  const sharedRootDir = sharedDir(home);
  const chatDir = spaceDir(home, 'chat');

  let db: DatabaseSync | null = null;
  let disposeRoutes: (() => void) | null = null;
  let disposeInjection: (() => void) | null = null;
  let disposeAutoWrite: (() => void) | null = null;
  let disposeTimeline: (() => void) | null = null;
  let disposeTurns: (() => void) | null = null;
  let disposeDream: (() => void) | null = null;
  const toolDisposers: Array<() => void> = [];

  ctx.effect(() => {
    // 1) 目录约定。**只有三样东西**：常驻记忆+全局共用 / 聊天记忆 / 项目记忆。
    ensureSpaceVault(sharedRootDir, 'shared');
    ensureSpaceVault(chatDir, 'chat');
    ensureSpaceVault(projectSpaceDir(home), 'project-space');
    // 工作区登记表：不存在就写下带注释的骨架，让用户一眼看懂能怎么改
    if (ensureRegistryFile(home)) ctx.logger.info(`dsh-mem: 已创建工作区登记表 ${workspacesYamlPath(home)}`);

    // 1.5) 旧结构迁移。
    //  ① `spaces/project/_shared/`（跨项目层）已并入常驻记忆层 —— 内容语义有变，**只告警不自动搬**；
    //  ② `spaces/project/proj/<key>/` → `spaces/project/projects/<项目名>/` —— 纯位置搬家，
    //     自动做（数据一字不改，只是换个更可读的目录名）。
    const legacy = detectLegacyShared(home);
    if (legacy.exists) {
      if (legacy.hasContent) {
        ctx.logger.warn(
          `dsh-mem: 发现旧的跨项目层 ${legacy.dir} —— 它已并入常驻记忆层（${sharedRootDir}）。` +
            '里面的内容**不会被自动搬运**，请确认后手动把需要的文件移过去，再删掉这个目录。',
        );
      } else {
        ctx.logger.info(`dsh-mem: 旧的跨项目层 ${legacy.dir} 只剩模板骨架，可以删掉`);
      }
    }
    const moved = migrateLegacyProjectDirs(home);
    if (moved.length > 0) {
      ctx.logger.info(`dsh-mem: 已把 ${moved.length} 个项目目录从 proj/ 搬到 projects/：${moved.join('、')}`);
    }

    // 1.5) 跨月滚动：「本月」里已经过去的月份，由**代码**搬进「早期月份」。
    //
    // 判据是确定的（今天几号 vs 小节标题里的月份），所以不交给 dream agent ——
    // 它只会在"想得起来"的时候做，于是「本月」越堆越长、注入的上下文里长期挂着
    // 几个月前的事。这里与每次 dream 之前都跑一遍，做一个便宜的幂等自愈。
    {
      const now = new Date();
      const rolled = rolloverMonthSections(sharedRootDir, now);
      for (const dir of [chatDir, projectSpaceDir(home), ...projectEntryDirs(home)]) {
        rolled.push(...rolloverMonthSections(dir, now));
      }
      for (const r of rolled) {
        ctx.logger.info(
          `dsh-mem: 跨月滚动 ${r.from} → ${r.to}：${r.moved.map((m) => m.heading).join('、')}`,
        );
      }
    }

    // 2) 派生索引：从 vault 文件重建。
    //    项目记忆也要建进来 —— 跨项目检索（mem_search）靠的就是这份索引。
    //    注意条目主键是 `space:project:rel`（vault 内相对路径会让同名文件互相覆盖，实测过）。
    db = openIndex(indexDbPath(home));
    const shared = rebuildVault(db, sharedRootDir, 'shared', null);
    const chat = rebuildVault(db, chatDir, 'chat', null);
    let projectEntries = 0;
    for (const dir of projectEntryDirs(home)) {
      projectEntries += rebuildVault(db, dir, 'project', basename(dir)).indexed;
    }
    // 历史回填（§5.9）：`raw/turns/` 只覆盖插件在线期间的会话，把官方日志里
    // 没采过的补进来 —— 否则"最近 40 场"名不副实（实测 5/28）。
    // 日志只增不减 → 账本记字节数，没变过的会话直接跳过，不必每次解压几十 MB。
    const backfill = backfillRawTurns(home);
    // 消息原文（§5.8 索引三层的第二层）：同样是派生索引，从 raw/turns/*.jsonl 重建。
    const turnsBuilt = rebuildTurns(db, home);

    const api = createVaultApi(resolved, () => db);
    const overview = api.overview();

    ctx.logger.info(
      `dsh-mem: vault 就绪 ${root} | 常驻记忆+全局 ${shared.indexed} / 聊天记忆 ${chat.indexed} / ` +
        `项目记忆 ${projectEntries} 条 | 索引共 ${overview.indexEntries} 条 | ` +
        `原文轮次 ${turnsBuilt.indexed} 条 | ` +
        `历史回填 扫 ${backfill.scanned} / 跳过 ${backfill.skipped} / 补 ${backfill.added} 轮 | ` +
        `项目 ${overview.projects.length} 个`,
    );

    // dream 控制面（会话右键菜单的「现在整理」/「跳过整理」）。
    //
    // 跳过名单与待整理名单**不依赖 subagents**，现在就能读；只有 `start`（要派子 agent）
    // 得等 `subagents` 就绪 —— 见下面的 `tryRegisterDream`。所以这里用一层可变转发：
    // **路由先挂上，执行者后到位**，UI 不会因为启动竞态而拿不到菜单。
    let dreamRunner:
      | ((ids: string[]) => { ok: boolean; started: boolean; text?: string; error?: string })
      | null = null;
    let dreamRunning = false;

    const dreamRoutes = {
      state: () => ({
        skipped: readDreamSkip(home),
        pending: listPendingSessions(home, readState(home).dream.lastRunAt),
        running: dreamRunning,
      }),
      setSkip: (sid: string, skip: boolean) => setDreamSkip(home, sid, skip),
      start: (ids: string[]) =>
        dreamRunner === null
          ? {
              ok: false as const,
              started: false as const,
              error: 'subagents 服务还没就绪（整理要派子 agent）—— 稍后再点，或让 AI 用 mem_dream',
            }
          : dreamRunner(ids),
    };

    // 3) 记忆空间数据面（webServer 可能尚未就绪，内部会重试）。
    //    只有 `/dream` 一条是写路由，且它动的是**整理调度**（跳过名单 / 现在跑一次），
    //    不是记忆内容 —— 记忆正文依旧没有 HTTP 写入口。
    disposeRoutes = registerVaultRoutes(ctx, api, {
      dream: dreamRoutes,
      workspaceView: () => ({
        registryPath: workspacesYamlPath(home),
        default: readRegistry(home).default,
        spaces: readRegistry(home).spaces,
        partitions: listProjectBriefs(projectEntriesDir(home), listPartitionKeys(home)).map((b) => ({
          key: b.key,
          name: b.name,
          path: b.path,
          entries: b.entries,
          timelineCount: b.timelineCount,
        })),
      }),
    });

    // 实体索引：注入与 mem_entity 工具**共用同一实例**。
    // 只有常驻记忆层与聊天记忆是固定来源 —— **项目记忆整体不注入**，所以不在这里。
    const entityIndex = new EntityIndex([sharedRootDir, chatDir]);

    // 4) 模型工具：常驻记忆**唯一**的写入路径 + 观察 + 时间线 + 检索 + 实体。
    //    没有 HTTP 写接口，也没有可手动改的入口——这条约束由结构保证。
    //
    //    所有落点都走 `resolveWorkspace` **同一个入口**（登记表 > 仓库标记 > default）：
    //    工具**拿不到**"写去哪里"这个参数，所以调用方没有机会写错地方。
    /**
     * 读当前会话的 agent preset id（§4.2.7）：`'chat'` → 聊天空间。
     *
     * **每轮现读、不缓存** —— 会话在空白期可以改选 preset，缓存一次会一直错。
     * **可选服务，拿不到就返回 null**（回退到 cwd 判定）：与 `subagents` / `webServer`
     * 属同一类晚就绪服务，但这里**不需要定时重试** —— 它在每轮、每次工具调用时被调用，
     * `ctx.get` 每次重新解析，晚就绪的下一轮自然就拿到了。
     */
    const presetOf = (agent: unknown): string | null => {
      try {
        const projections = (ctx as unknown as { get?: (n: string) => unknown }).get?.(
          'sessionProjections',
        ) as { stateOf?: (session: unknown, key: string) => unknown } | undefined;
        if (typeof projections?.stateOf !== 'function') return null;
        const session = (agent as { session?: unknown } | null | undefined)?.session;
        if (session === undefined || session === null) return null;
        const id = projections.stateOf(session, 'agentPreset');
        return typeof id === 'string' && id.length > 0 ? id : null;
      } catch {
        return null; // 投影服务抽风不该拖垮记忆
      }
    };

    const observeResolver = (
      cwd: string | null,
      agentPreset: string | null = null,
    ): ObserveSpace => {
      const r = resolveWorkspace(home, cwd, resolved.projectRootMarkers, agentPreset);
      if (r.kind === 'project' && r.key !== null) {
        return { kind: 'project', dir: ensureProjectEntry(home, r.key, r.root ?? '').dir };
      }
      const dir = spaceDir(home, 'chat');
      ensureSpaceVault(dir, 'chat');
      return { kind: 'chat', dir };
    };

    // 时间线的落点**故意与观察不同**：它记的是"哪个目录里的改动"，
    // 所以聊天工作区也按目录本身建一个项目目录，而不是丢进聊天记忆。
    const timelineResolver = (
      cwd: string | null,
      agentPreset: string | null = null,
    ): string | null => {
      if (cwd === null) return null; // 拿不到工作目录就不猜落点
      const r = resolveWorkspace(home, cwd, resolved.projectRootMarkers, agentPreset);
      if (r.kind === 'project' && r.key !== null) return ensureProjectEntry(home, r.key, r.root ?? '').dir;
      const norm = normalizeWorkspacePath(cwd);
      return ensureProjectEntry(home, projectKey(norm), norm).dir;
    };

    /**
     * 本会话要注入的层。
     *
     * **项目记忆整体不注入** —— 用户拍板：平时只注入「常驻记忆 + 全局共用」，
     * 项目里的具体内容由 AI 自己调工具取。所以这里只在**聊天会话**返回聊天记忆；
     * 在项目里返回空，改由 `resolveNotice` 给一行指针告诉它有哪些工具可用。
     */
    const resolveLayers = (
      cwd: string | null,
      agentPreset: string | null = null,
    ): InjectionLayer[] => {
      const r = resolveWorkspace(home, cwd, resolved.projectRootMarkers, agentPreset);
      if (r.kind === 'project') return [];
      return [{ label: '聊天记忆', dir: chatDir }];
    };

    // 项目会话：给一行**轻量指针**，说明项目记忆在哪、怎么取。
    // 这不是注入内容，只是告诉 AI "有东西可以翻" —— 开局给标题，正文按需取。
    const resolveNotice = (
      cwd: string | null,
      agentPreset: string | null = null,
    ): string | null => {
      if (cwd === null) return null;
      const r = resolveWorkspace(home, cwd, resolved.projectRootMarkers, agentPreset);

      if (r.kind === 'project' && r.key !== null) {
        const briefs = listProjectBriefs(projectEntriesDir(home), listPartitionKeys(home));
        const mine = briefs.find((b) => b.key === r.key);
        if (mine === undefined || !mine.initialized) return null;
        return [
          `你在项目 **${mine.name}** 里。它的记忆（${mine.entries} 条、${mine.timelineCount} 条时间线）`,
          '**不在你的上下文里** —— 项目记忆不主动注入。需要时自己取：',
          '`mem_search` 检索（可跨项目）、`mem_entity` 翻实体页、`mem_diff` 看某条改动的完整内容。',
        ].join('\n');
      }

      // 未登记工作区：**只问一次**（问过就记进 state.json，不反复打扰）
      if (r.source !== 'unregistered' || wasAsked(home, cwd)) return null;
      markAsked(home, cwd);
      return [
        `这个工作目录（\`${normalizeWorkspacePath(cwd)}\`）还没有登记类型，当前按**聊天记忆**处理。`,
        '如果它其实是个项目，顺口跟用户确认一句；确认后用 `mem_space` 登记成 project，',
        '那样它的记忆会进「项目记忆」里自己的目录、与别的项目互不干扰。',
        '（这个问题只问一次，不会反复打扰。）',
      ].join('\n');
    };

    // 其它项目的**轻量指针**：用户提到别的项目时给规模与入口，不给正文
    const resolvePointers = (
      cwd: string | null,
      userText: string,
      agentPreset: string | null = null,
    ): string | null => {
      const r = resolveWorkspace(home, cwd, resolved.projectRootMarkers, agentPreset);
      const briefs = listProjectBriefs(projectEntriesDir(home), listPartitionKeys(home));
      return renderPointers(mentionedProjects(briefs, r.key, userText));
    };

    /**
     * 跨项目检索。**每次先刷新索引再查**：
     * vault 是事实源、索引只是缓存，而用户随时可能手改文件 ——
     * 与其维护增量失效逻辑，不如每次重建（这个量级下重建比维护便宜）。
     */
    const refreshIndex = (): void => {
      if (db === null) return;
      rebuildVault(db, sharedRootDir, 'shared', null);
      rebuildVault(db, chatDir, 'chat', null);
      for (const dir of projectEntryDirs(home)) {
        rebuildVault(db, dir, 'project', basename(dir));
      }
      rebuildTurns(db, home);
    };

    const search = (
      query: string,
      opts: { k: number; scope: 'all' | 'current'; cwd: string | null; agentPreset?: string | null },
    ): SearchHit[] => {
      if (db === null) return [];
      refreshIndex();
      const hits = searchEntries(listEntries(db), query, { k: opts.scope === 'current' ? 200 : opts.k });
      if (opts.scope !== 'current') return hits;
      const r = resolveWorkspace(home, opts.cwd, resolved.projectRootMarkers, opts.agentPreset ?? null);
      const keep =
        r.kind === 'project'
          ? (e: { space: string; project: string | null }): boolean =>
              e.space === 'project' && (e.project === '_shared' || e.project === r.key)
          : (e: { space: string }): boolean => e.space === 'chat' || e.space === 'shared';
      return hits.filter((h) => keep(h.entry)).slice(0, opts.k);
    };

    // dream 的手动入口（「现在整理」）。需要宿主的 `subagents` 服务才能派子 agent。
    //
    // **必须重试，不能只拿一次**：DSH 里各插件是**并发启动**的，`subagents` 很可能
    // 比本插件晚就绪 —— 只拿一次就会拿到 undefined、于是工具根本不注册（实测踩过）。
    // 这个坑路由那边早就踩过（`webServer` 同样是可选服务，那里是每秒重试 20 次），
    // **这次是把那条经验补搬到 subagents 上**。
    interface SubagentService {
      start(
        name: string,
        req: { label?: string; prompt: unknown[]; parent: unknown; signal: AbortSignal },
      ): Promise<{
        result: Promise<{ output: Array<{ type?: string; text?: string }> }>;
        dispose(): Promise<void>;
      }>;
    }

    let dreamTimer: ReturnType<typeof setTimeout> | null = null;
    let dreamStopped = false;

    const tryRegisterDream = (attempt: number): void => {
      if (dreamStopped) return;
      const subagents = (ctx as unknown as { get?: (n: string) => unknown }).get?.('subagents') as
        | SubagentService
        | undefined;

      if (subagents === undefined) {
        if (attempt >= 20) {
          ctx.logger.warn(
            'dsh-mem: subagents 服务 20s 内未就绪 —— 「现在整理」未注册（定时那套不受影响）',
          );
          return;
        }
        dreamTimer = setTimeout(() => tryRegisterDream(attempt + 1), 1000);
        return;
      }

      const dreamCap = {
        pending: () => listPendingSessions(home, readState(home).dream.lastRunAt),
        skipped: () => readDreamSkip(home),
        setSkip: (sid: string, skip: boolean) => setDreamSkip(home, sid, skip),
        run: async (sessionIds: string[], parent: unknown) => {
          const spawn = async ({ label, prompt }: { label: string; prompt: string }): Promise<string> => {
            const run = await subagents.start('spawn', {
              label,
              prompt: [{ type: 'text', text: prompt }],
              parent,
              signal: new AbortController().signal,
            });
            try {
              const res = await run.result;
              return res.output
                .filter((b) => b.type === 'text' && typeof b.text === 'string')
                .map((b) => b.text ?? '')
                .join('');
            } finally {
              await run.dispose().catch(() => undefined);
            }
          };
          // 汇总之前先把跨月滚动做掉，让阶段 B 看到的就是已经滚好的段落
          // （阶段 B 是 agent 在写文件，宿主能确定完成的只有这一步前的准备）。
          for (const dir of [sharedRootDir, chatDir, projectSpaceDir(home), ...projectEntryDirs(home)]) {
            for (const r of rolloverMonthSections(dir, new Date())) {
              ctx.logger.info(
                `dsh-mem: 跨月滚动 ${r.from} → ${r.to}：${r.moved.map((m) => m.heading).join('、')}`,
              );
            }
          }
          return runDream({ home, logger: ctx.logger, spawn, template: loadPrompt }, sessionIds);
        },
      };

      /**
       * 找一个人当「父 agent」—— 派子 agent 必须有父（`parent.session` 会被用到）。
       *
       * **父是谁不影响整理结果**：素材来自 `raw/turns/`，父只是个归属与环境句柄。
       * 所以优先级是"谁活着用谁"：**点的那一场自己的 agent → 任何活着的顶层会话**。
       * 都空就**明确报错，不凭空造会话** —— 造出来的会话会真的落库，在侧栏里多一条，
       * 为了跑一次整理污染用户的会话列表不划算。
       */
      const resolveDreamParent = (preferred: string | undefined): unknown => {
        const agents = (ctx as unknown as { get?: (n: string) => unknown }).get?.('agents') as
          | { get?(id: string): unknown; roots?(): unknown[] }
          | undefined;
        if (agents === undefined) return null;
        try {
          if (preferred !== undefined && preferred !== '') {
            const live = agents.get?.(preferred);
            if (live !== undefined && live !== null) return live;
          }
          const roots = agents.roots?.();
          if (Array.isArray(roots) && roots.length > 0) return roots[0];
        } catch (e) {
          ctx.logger.warn(`dsh-mem: 找父 agent 出错: ${e instanceof Error ? e.message : String(e)}`);
        }
        return null;
      };

      dreamRunner = (ids: string[]) => {
        if (dreamRunning) {
          return { ok: false, started: false, error: '已经有一次整理在跑，等它结束' };
        }
        const target =
          ids.length > 0 ? ids : listPendingSessions(home, readState(home).dream.lastRunAt);
        if (target.length === 0) {
          return { ok: true, started: false, text: '没有待整理的会话 —— 不用跑（不烧钱）' };
        }
        const parent = resolveDreamParent(ids[0]);
        if (parent === null) {
          return {
            ok: false,
            started: false,
            error: '当前没有活着的会话可以当父 agent —— 先打开任一会话再点',
          };
        }
        dreamRunning = true;
        ctx.logger.info(`dsh-mem: 「现在整理」开始 —— ${target.length} 个会话`);
        void (async () => {
          try {
            const report = await dreamCap.run(target, parent);
            ctx.logger.info(
              `dsh-mem: 「现在整理」结束 —— ${report.outcome}：${report.extracts} 份产出 / ` +
                `${report.observations} 条观察` +
                `${report.failed.length > 0 ? ` / 失败 ${report.failed.length} 路` : ''}`,
            );
          } catch (e) {
            ctx.logger.warn(`dsh-mem: 「现在整理」失败: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            dreamRunning = false;
          }
        })();
        return { ok: true, started: true, text: `已开始整理 ${target.length} 个会话` };
      };

      const dispose = (ctx.tools as { register(t: unknown): unknown }).register(dreamTool(dreamCap));
      if (typeof dispose === 'function') toolDisposers.push(dispose as () => void);
      ctx.logger.info(
        `dsh-mem: 「现在整理」（mem_dream）已注册${attempt > 0 ? `（等了 ${attempt} 秒等到 subagents）` : ''}`,
      );
    };

    tryRegisterDream(0);

    registerMemTools(
      (t) => {
        const dispose = (ctx.tools as { register(t: unknown): unknown }).register(t);
        if (typeof dispose === 'function') toolDisposers.push(dispose as () => void);
      },
      {
        sharedDir: sharedRootDir,
        index: entityIndex,
        // 空间判定要读 preset（§4.2.7）：'chat' → 聊天空间。
        presetOf,
        observeResolver,
        timelineResolver,
        diffMaxChars: resolved.diffMaxChars,
        search,
        workspaces: {
          home,
          markers: resolved.projectRootMarkers,
          entriesDir: projectEntriesDir(home),
        },
      },
    );
    ctx.logger.info(
      'dsh-mem: 工具已注册（mem_remember / mem_forget / mem_observe / mem_diff / mem_search / mem_space / mem_entity）',
    );

    // 5) 注入：静态手册（system prompt，文本恒定）+ 动态记忆（pre-step，插在用户消息前）
    //    实体索引只扫 shared / chat 两个固定 vault（v10：跨项目层已并入 shared）。
    //    ⚠️ v10 之后 `resolveLayers` 对项目会话返回空，于是项目分区的实体
    //    **既不在开局目录里、也进不了 `mem_entity` 的索引**（那个工具只吃这个索引）；
    //    但注入的指针文案还在让模型用 `mem_entity` 翻项目实体页 —— 这条落差待定。
    disposeInjection = installInjection(
      ctx as unknown as Parameters<typeof installInjection>[0],
      {
        sharedVaultDir: sharedRootDir,
        maxChars: resolved.injectMaxChars,
        entityIndex,
        entityMaxChars: resolved.entityMaxChars,
        resolveLayers,
        resolveNotice,
        resolvePointers,
        // RCC（§5.8）：**拼装与状态回写放这里**（只有宿主才知道 DB 与空间判定），
        // 去重账本放注入层（那是会话状态）。两个钩子都自己判空间 ——
        // 不是聊天空间就返回空，注入层不需要知道"哪些 preset 算聊天"。
        rcc: resolved.rcc
          ? {
              build: (s: { cwd: string | null; agentPreset: string | null }) => {
                if (db === null) return null;
                const kind = resolveWorkspace(home, s.cwd, resolved.projectRootMarkers, s.agentPreset).kind;
                if (kind !== 'chat') return null;
                const built = buildRcc(db, {
                  sessions: resolved.rccSessions,
                  head: resolved.rccHeadChars,
                  tail: resolved.rccTailChars,
                  headTurns: resolved.rccHeadTurns,
                  tailTurns: resolved.rccTailTurns,
                  maxChars: resolved.rccMaxChars,
                });
                if (built === null) return null;
                // 回写「哪些场进了 RCC」「其中哪些被裁过」—— 补丁链路每轮查它，
                // **不能每轮重算**（按 token 裁不保证重放一致）。
                // 先整体复位再置位：否则"上次裁过、这次没裁"的场会一直挂着旧状态。
                setRccState(
                  db,
                  listSessions(db).map((x) => x.session),
                  { inRcc: false, truncated: false },
                );
                setRccState(db, built.covered, { inRcc: true });
                setRccState(db, built.truncated, { truncated: true });
                if (built.folded.length > 0) {
                  // 手滑点出来的分叉会话：界面上删了，日志还在磁盘上（DSH 不删会话文件），
                  // 所以只能由这里折叠掉 —— 否则同一段历史会在 RCC 里出现好几遍。
                  ctx.logger.info(
                    `dsh-mem: RCC 折叠了 ${built.folded.length} 个重复分支（内容被别的场包含）`,
                  );
                }
                return built.text;
              },
              patch: (s: { cwd: string | null; agentPreset: string | null }, userText: string) => {
                if (db === null) return [];
                const kind = resolveWorkspace(home, s.cwd, resolved.projectRootMarkers, s.agentPreset).kind;
                if (kind !== 'chat') return [];
                return patchCandidates(db, userText, {
                  k: resolved.rccPatchK,
                  maxChars: resolved.rccPatchChars,
                  // 判据是「原话**在被砍掉的对话里面**」——所以要把 RCC 的裁剪参数传下去，
                  // 让"这一轮到底有没有被砍掉"能算出来（光知道"这场被裁过"不够）。
                  cut: {
                    head: resolved.rccHeadChars,
                    tail: resolved.rccTailChars,
                    headTurns: resolved.rccHeadTurns,
                    tailTurns: resolved.rccTailTurns,
                  },
                });
              },
            }
          : undefined,
        presetOf,
      },
    );

    // 6) "用户要求记住"的提醒（P4）：只在用户**明说**要记住时 steer 一条指令。
    //    轮次级的"顺手记一笔"已取消 —— 用户拍板"不要在对话过程中频繁改动 memory"，
    //    其余提炼交给晚上跑的 dream（它读 raw/turns/ 自己判断）。
    disposeAutoWrite = installAutoWrite(
      ctx as unknown as Parameters<typeof installAutoWrite>[0],
      { enabled: resolved.autoWrite },
    );

    // 6.5) 原始轮次采集：把每轮的对话原文追加进 `raw/turns/<session>.jsonl`。
    //      **没有 LLM 调用、没有 steer** —— 只是把素材存下来给 dream 读。
    //      这是"对话中不碰记忆"能成立的前提：判断推迟到晚上，但素材不能丢。
    disposeTurns = installTurnCapture(
      ctx as unknown as Parameters<typeof installTurnCapture>[0],
      { enabled: resolved.captureTurns, home },
    );

    // 7) 项目时间线（P4.5）：tools/result 抄 diff → 轮次结束聚合成一条摘要 + 详情文件。
    //    摘要进 timeline.md、详情进 raw/timeline/ —— **两层都不主动注入**（v10）。
    disposeTimeline = installTimeline(
      ctx as unknown as Parameters<typeof installTimeline>[0],
      { enabled: resolved.timeline, resolveVault: timelineResolver },
    );

    // 6.6) dream（P6）的**调度内核**：每晚到点、闲置够了、有素材、没租约 → 才跑。
    //      **编排（派 agent）还没实现**，所以 `run` 不传 —— `installDream` 会明确说
    //      "调度器未启动"而不是空转一夜。判定逻辑已就绪，接上 run 即生效。
    disposeDream = installDream(
      ctx as unknown as Parameters<typeof installDream>[0],
      {
        enabled: resolved.dream,
        home,
        at: parseClock(resolved.dreamAt) ?? { hour: 3, minute: 0 },
        idleMinutes: resolved.dreamIdleMinutes,
        cooldownHours: resolved.dreamCooldownHours,
      },
    );

    return () => {
      dreamStopped = true;
      if (dreamTimer !== null) clearTimeout(dreamTimer);
      disposeDream?.();
      disposeDream = null;
      disposeTurns?.();
      disposeTurns = null;
      disposeTimeline?.();
      disposeTimeline = null;
      disposeAutoWrite?.();
      disposeAutoWrite = null;
      disposeInjection?.();
      disposeInjection = null;
      disposeRoutes?.();
      disposeRoutes = null;
      for (const d of toolDisposers.splice(0)) {
        try {
          d();
        } catch {
          /* 注销失败不阻塞其余 */
        }
      }
      closeIndex(db);
      db = null;
    };
  });

  ctx.logger.info(`dsh-mem: applied (home=${home}, promptLang=${resolved.promptLang})`);
}
