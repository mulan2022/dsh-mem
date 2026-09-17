/**
 * RCC —— 聊天原文召回，以及它的**补丁**（设计文档 §5.8）。
 *
 * RCC = 最近 N 场会话（计数单位是**场**，不是消息）里**用户的全部发言**，
 * 逐字引用、不加摘要、不做检索。场与场之间、场内的发言之间用 `||||` 分隔。
 *
 * 它解决的问题：聊天记忆是**散的态度/生活/情绪**，没有天然结构，靠"最近说过什么"
 * 兜底比靠检索准。而项目空间**不用它** —— 那边已经有"时间线摘要常驻 + 详情按需取"，
 * 再挂一套就是同一个问题两个答案。
 *
 * **补丁**是它的补丁：RCC 很大，按 token 裁中段时留下显式 `[TL;DR]` 标记。
 * 每轮之前拿本轮用户消息去 `turns.user_text` 上做 BM25，命中**且那一轮在 RCC 里被裁掉**
 * 就把**那一轮**的完整原话**追加**一条 —— 不重发 RCC、不动别的场、也**不整场端上来**。
 *
 * 两条闸门（都是 2026-09-17 用户看过实际注入后加的）：
 *  - **补的是"触发关键词的那一个对话"**（用户原话），不是整场 —— 整场一份 2k+ 字符，
 *    而他要的只是那句话说全；
 *  - **泛词不算命中**：查询词在语料里太常见（`记忆` 24.7% / `这个` 35%）就没有辨识度，
 *    不能单独把一场拉出来。只有"有辨识度的词"命中才算（`rcc` 4.5% 算）。
 *
 * **成本上界**：每轮最多 `k` 段 × 一轮原话的长度；同一轮在本会话里只补一次。
 */
import type { DatabaseSync } from 'node:sqlite';

import { listSessions, listTurns, type SessionRow, type TurnRow } from './index-db.js';
import { tokenize } from './search.js';

/** 一场里用户两句话之间的分隔符（用户给的形态）。 */
export const RCC_SEP = '||||';

/**
 * 中段被裁时留下的标记。
 *
 * **刻意只有一个 `[TL;DR]`**（用户 2026-09-17：「这个**此处省略 xx 字**不要放进去啊，
 * 不更耗 token 了吗」）—— 标记本身也吃 token，而"省了多少"是**我们自己算得出来的**，
 * 没必要每次注入都带上。
 *
 * 为什么还得留这个标记：模型要知道"这里被裁了"，否则会把省略当成用户真打了省略号。
 */
export const RCC_TRUNCATED = '[TL;DR]';

export interface CutResult {
  text: string;
  truncated: boolean;
}

/** 单条发言默认保留的头/尾字数（用户拍板 2026-09-15：「按头 60 字尾 40 字算」）。 */
export const DEFAULT_HEAD = 60;
export const DEFAULT_TAIL = 40;

/**
 * 一场默认保留的头/尾**句数**：**头 12 / 尾 0**。
 *
 * Kimi 那边是"整场只留 12 句，剩下的全没了" —— 用户 09-15 调研回来确认，
 * **这正是它能保留 40 场的原因**（否则一场 100 轮根本放不下）。
 * 差别在于：它砍掉就没了，我们砍掉的部分**有补丁能补回来**（§5.8 的补丁链路）。
 *
 * 一开始抄成了"头 6 + 尾 6"，用户 2026-09-17 纠正：「整个场截断就保留**前面 12 条**啊，
 * 不是前 6 条后 6 条」。**尾 0 是刻意的**：聊天里"开头"是起因，"结尾"往往只是寒暄，
 * 而最近的场本来就整场完整带上（只有老场才会被截），老场的结尾价值最低。
 */
export const DEFAULT_HEAD_TURNS = 12;
export const DEFAULT_TAIL_TURNS = 0;

/**
 * 掐中段时头尾的**比例**（头 60% / 尾 40%）。
 *
 * 与单条发言的 60 字 / 40 字是同一个比例 —— 凡是"给个上限、超了就掐"的地方
 * 都按这个比例掐中段，**不许只留头**。真踩过：补丁的兜底一度传了 `tail = 0`，
 * 于是尾巴被整个砍光，跟"掐中段"的规格不符（用户当场指出）。
 */
export const HEAD_RATIO = 0.6;

/** 按比例把上限拆成头/尾两段（头多尾少）。 */
export function splitCap(cap: number): { head: number; tail: number } {
  const head = Math.max(0, Math.floor(cap * HEAD_RATIO));
  return { head, tail: Math.max(0, cap - head) };
}

/**
 * 掐中段：保留头 `head` 字与尾 `tail` 字，中间换成显式标记。
 *
 * **用户拍板（2026-09-15）纠正过一处**：「不是掐单场的中段，**是掐用户单句话说的太长的中段**」
 * —— 裁剪的单位是**一条发言**，不是一整场（见 `sessionUserText`）。
 */
export function cutMiddle(text: string, head: number, tail: number): CutResult {
  const cap = head + tail;
  if (cap <= 0 || text.length <= cap) return { text, truncated: false };
  const headText = head > 0 ? text.slice(0, head) : '';
  const tailText = tail > 0 ? text.slice(text.length - tail) : '';
  // 只留 `[TL;DR]` 三个记号，不带"省略了多少"（那也吃 token，而且算得出来）
  return { text: [headText, RCC_TRUNCATED, tailText].filter((p) => p !== '').join('\n'), truncated: true };
}

/** `0903T20:10` —— 场编号里的日期时间（本地时间）。 */
export function sessionStamp(startedAt: number | null, fallback: Date = new Date()): string {
  const d = startedAt === null || !Number.isFinite(startedAt) ? fallback : new Date(startedAt);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 场的标题。
 *
 * `sessions.title` 还没接 `dsh-session-title`（待办 ⑧），所以现在几乎全是 null ——
 * 退回"这一场用户说的第一句的前 N 字"。比只给个编号有用得多，而且不引新依赖。
 */
export function sessionTitle(row: SessionRow, turns: readonly TurnRow[], maxChars = 24): string {
  const t = row.title?.trim();
  if (t !== undefined && t !== '') return t;
  const first = turns.find((x) => x.userText.trim() !== '')?.userText.trim() ?? '';
  const flat = first.replace(/\s+/g, ' ');
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/**
 * 裁剪参数 —— **两层**：
 *  - `head` / `tail`：单条发言保留多少**字**（掐中段）；
 *  - `headTurns` / `tailTurns`：一整场保留多少**句**（头几句 + 尾几句，中间的换成标记）。
 *
 * 两层都为 0 表示**不裁**（取完整原文时用）。
 */
export interface CutOptions {
  head: number;
  tail: number;
  headTurns: number;
  tailTurns: number;
}

/** 默认裁剪参数：单条 60+40 字，整场头 12 + 尾 0 句。 */
export const DEFAULT_CUT: CutOptions = {
  head: DEFAULT_HEAD,
  tail: DEFAULT_TAIL,
  headTurns: DEFAULT_HEAD_TURNS,
  tailTurns: DEFAULT_TAIL_TURNS,
};

/** 不裁：取完整原文。 */
export const NO_CUT: CutOptions = { head: 0, tail: 0, headTurns: 0, tailTurns: 0 };

/**
 * 取一场的用户发言（逐字，`||||` 分隔）。**只用 `userText`** —— §5.8 的硬约束。
 *
 * **两层裁剪**：
 *  1. 整场：只留**头** `headTurns` 句（默认 **12**，`tailTurns` 默认 **0** —— 用户
 *     2026-09-17 明确「整场截断就保留**前面 12 条**啊，不是前 6 条后 6 条」），
 *     中间插一个 `[TL;DR]`；
 *  2. 每条留下的发言：再按 `head`/`tail` 字掐中段。
 *
 * 为什么整场只留开头、而**单条**发言仍两头都留：老场的开头是起因，最值钱；而单条发言
 * 掐中段时两头都便宜（60+40 字），只留头会把话的落点丢掉。
 *
 * 为什么不是"整场当一坨来掐"（用户 09-15 纠正过）：那样会把中间那几十条**整条丢掉**，
 * 连开头都不剩；逐条掐只丢每条里的过程，**那条发言本身还在、还能被补丁补全**。
 */
export function sessionUserText(
  turns: readonly TurnRow[],
  cut: CutOptions = DEFAULT_CUT,
): { text: string; truncated: boolean; cutCount: number; droppedTurns: number } {
  const lines = turns.map((t) => t.userText.trim()).filter((t) => t !== '');
  const headN = Math.max(0, cut.headTurns);
  const tailN = Math.max(0, cut.tailTurns);
  const keepAll = headN + tailN <= 0 || lines.length <= headN + tailN;
  const omitted = keepAll ? 0 : lines.length - headN - tailN;

  const parts: string[] = [];
  let cutCount = 0;
  const pushLine = (line: string): void => {
    const r = cutMiddle(line, cut.head, cut.tail);
    if (r.truncated) cutCount++;
    parts.push(r.text);
  };

  if (keepAll) {
    for (const line of lines) pushLine(line);
  } else {
    for (const line of lines.slice(0, headN)) pushLine(line);
    parts.push(RCC_TRUNCATED); // 同样只留记号，不带"省略了 N 句"
    for (const line of lines.slice(lines.length - tailN)) pushLine(line);
  }

  return {
    text: parts.join(`\n${RCC_SEP}\n`),
    truncated: cutCount > 0 || omitted > 0,
    cutCount,
    droppedTurns: omitted,
  };
}

export interface RccBuildOptions {
  /** 覆盖多少场（"最近 N 场"）。 */
  sessions: number;
  /** 单条用户发言保留的头 N 字。 */
  head: number;
  /** 单条用户发言保留的尾 N 字。 */
  tail: number;
  /** 一整场保留的头 N 句。 */
  headTurns: number;
  /** 一整场保留的尾 N 句。 */
  tailTurns: number;
  /** RCC 整块的字符预算；超出从**最旧的场**开始丢。 */
  maxChars: number;
}

export interface RccBuildResult {
  text: string;
  /** 进了 RCC 的场（调用方写回 `in_rcc = 1`）。 */
  covered: string[];
  /** 其中被裁过的场（调用方写回 `rcc_truncated = 1`）—— 补丁链路只认这些。 */
  truncated: string[];
  /** 被整块预算挤掉的最旧的场。 */
  dropped: string[];
  /** 因为"内容被另一场完全包含"而折叠掉的重复场（见 `foldContained`）。 */
  folded: string[];
  chars: number;
}

/** `short` 是不是 `long` 的前缀（按用户发言逐条比）。 */
export function isPrefixOf(short: readonly string[], long: readonly string[]): boolean {
  if (short.length > long.length) return false;
  for (let i = 0; i < short.length; i++) if (short[i] !== long[i]) return false;
  return true;
}

/**
 * 折叠「内容被另一场完全包含」的重复场。
 *
 * **真踩过（2026-09-17 用户报）**：他手滑点了「分叉会话」，fork 出来的分支**用户发言就是父会话的前缀**。
 * 而 DSH 的会话日志**只增不减、根本没有删除 API**（`dsh-session-persistence-jsonl` 明文写着
 * 「Nothing deletes session files」）—— 所以他在界面上把分支删了，**日志还在磁盘上**，
 * 我们的回填照样读得到 → RCC 里同一段历史出现**三遍**（父 + 两条空分支）。
 *
 * **判据用内容前缀，不用 `parentSession`**：真 fork 之后两条分支会各自展开、内容就分叉了，
 * **只有"fork 完没动"的才会逐字相同** —— 所以这条判据在真实使用中不会误伤真分叉。
 * （`parentSession` 可以当旁证，但它指向的父会话不一定在 RCC 覆盖范围内。）
 *
 * 实现：按长度**从长到短**过一遍，短的是已保留某场的前缀就折叠掉。
 * 等长的两份只会留先出现的那条（它的前缀关系成立）。空序列不参与折叠。
 *
 * @returns `kept` 保持**传入顺序**（调用方按它编号）；`folded` 是被折叠掉的 id。
 */
export function foldContained<T>(
  items: readonly T[],
  linesOf: (item: T) => readonly string[],
  idOf: (item: T) => string,
): { kept: T[]; folded: string[] } {
  const seq = items.map((it) => linesOf(it));
  const order = items.map((_, i) => i).sort((a, b) => seq[b].length - seq[a].length);
  const keepIdx: number[] = [];
  const foldedIdx = new Set<number>();
  for (const i of order) {
    if (seq[i].length > 0 && keepIdx.some((k) => isPrefixOf(seq[i], seq[k]))) {
      foldedIdx.add(i);
      continue;
    }
    keepIdx.push(i);
  }
  return {
    kept: items.filter((_, i) => !foldedIdx.has(i)),
    folded: items.filter((_, i) => foldedIdx.has(i)).map((it) => idOf(it)),
  };
}

/**
 * 拼一份 RCC。
 *
 * **纯函数**：只读库，不写状态。哪些场进了、哪些被裁，都由返回值告诉调用方去回写
 * （`sessions.in_rcc` / `rcc_truncated`）—— 回写是调用方的事，这样这里能单测。
 *
 * 没有任何场时返回 null（不产生空消息）。
 */
export function buildRcc(db: DatabaseSync, opts: RccBuildOptions): RccBuildResult | null {
  const all = listSessions(db);
  const recent = opts.sessions > 0 ? all.slice(-opts.sessions) : all;
  if (recent.length === 0) return null;

  const rendered = recent.map((row) => {
    const turns = listTurns(db, { session: row.session });
    const cut = sessionUserText(turns, {
      head: opts.head,
      tail: opts.tail,
      headTurns: opts.headTurns,
      tailTurns: opts.tailTurns,
    });
    // 折叠判据用的是**未裁的原话序列**（裁剪后的文本会因参数变化而不同，不适合当身份）
    const lines = turns.map((t) => t.userText.trim()).filter((t) => t !== '');
    return { row, turns, lines, body: cut.text, truncated: cut.truncated };
  });

  // 先折叠重复分支，再算预算 —— 顺序反了的话，被折叠的那两份会先把预算吃满
  const foldedRes = foldContained(
    rendered,
    (r) => r.lines,
    (r) => r.row.session,
  );
  const unique = foldedRes.kept;

  // 整块预算：从最旧的开始丢，保留最近的
  const overhead = 48; // 每场标题行的大致开销
  let total = unique.reduce((n, r) => n + r.body.length + overhead, 0);
  const dropped: string[] = [];
  let from = 0;
  while (total > opts.maxChars && from < unique.length - 1) {
    total -= unique[from].body.length + overhead;
    dropped.push(unique[from].row.session);
    from++;
  }
  const kept = unique.slice(from);

  const text = kept
    .map((r, i) => {
      const title = sessionTitle(r.row, r.turns);
      const stamp = sessionStamp(r.row.startedAt);
      return `${i + 1}. ${stamp}${title === '' ? '' : ` ${title}`}\n${r.body}`;
    })
    .join('\n\n');

  return {
    text,
    covered: kept.map((r) => r.row.session),
    truncated: kept.filter((r) => r.truncated).map((r) => r.row.session),
    dropped,
    folded: foldedRes.folded,
    chars: text.length,
  };
}

export interface RankedTurn {
  turn: TurnRow;
  score: number;
}

/**
 * 在若干轮用户发言上做 BM25（k1=1.5 / b=0.75，与 §13.3 的打分器同规格）。
 *
 * 匹配面就是 `user_text` 本身 —— 跟记忆检索那边"只匹配 keywords"不同：
 * 这里**没有** keywords 可匹配（原文没有那层摘要），而且原文本来就是口语，
 * idf 与长度归一化正好压掉"一句话里常见字多"的噪音。
 */
export function rankTurns(query: string, turns: readonly TurnRow[], k: number): RankedTurn[] {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0 || turns.length === 0 || k <= 0) return [];

  const docs = turns.map((t) => tokenize(t.userText));
  const n = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / n || 1;

  const df = new Map<string, number>();
  const tf = docs.map((toks) => {
    const m = new Map<string, number>();
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return m;
  });

  const k1 = 1.5;
  const b = 0.75;
  const scored: RankedTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const len = docs[i].length;
    let s = 0;
    for (const term of q) {
      const f = tf[i].get(term);
      if (f === undefined) continue;
      const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgdl)));
    }
    if (s > 0) scored.push({ turn: turns[i], score: s });
  }
  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, k);
}

export interface RccPatch {
  /** 去重键 —— `会话 id#轮次`（同一**轮**在本会话里只补一次，换一轮可以再补）。 */
  key: string;
  /** 给人看的标签（场号 + 时间 + 标题 + 轮次），写进日志与消息摘要。 */
  label: string;
  /** 命中那一轮**完整的**用户原话。 */
  text: string;
}

/** 补丁的语言：它是**追加**，不是 RCC 的一部分 —— 所以开头要说清它补的是哪一场的哪一轮。 */
export function renderPatch(label: string, body: string): string {
  return [
    `### RCC 补全 · ${label}`,
    `这一轮在 RCC 里被 ${RCC_TRUNCATED} 裁掉了，以下是它**完整的**原话：`,
    '',
    body,
  ].join('\n');
}

/**
 * 泛词门槛（2026-09-17）：一个词在语料里出现得越普遍，越没有"把某一轮捞出来"的能力。
 *
 * 阈值不是拍的 —— 在真实库上量过（223 轮）：
 * `这个` 35.0% / `记忆` 24.7% / `现在` 23.3% / `一下` 15.7% 全是泛词，
 * 而 `rcc` 4.5% / `机票` 0% 这种才有辨识度。
 * 只有**有辨识度的词**命中，才允许补丁 —— 否则一句"宝宝你有记忆了吗"就能把
 * 几场二十年陈年老账全拉进上下文（实测：一轮 8k 字符）。
 *
 * `MIN_DF` 是给小子库的兜底：语料只有十几轮时，"10%"可能等于 1~2 轮，
 * 那不算普遍。
 */
export const PATCH_GENERIC_DF_RATIO = 0.1;
export const PATCH_GENERIC_MIN_DF = 3;

/**
 * 这次查询里**有辨识度的词**（= 不是泛词）。
 *
 * 返回空数组 = 整句话都是泛词 → 这一轮**不产生任何补丁**（宁可少补，不少捞）。
 */
export function distinctiveTokens(query: string, turns: readonly TurnRow[]): string[] {
  const q = [...new Set(tokenize(query))];
  if (q.length === 0) return [];
  const docs = turns.map((t) => new Set(tokenize(t.userText)));
  const n = docs.length;
  const out: string[] = [];
  for (const term of q) {
    let df = 0;
    for (const d of docs) if (d.has(term)) df++;
    const generic = n > 0 && df >= PATCH_GENERIC_MIN_DF && df / n >= PATCH_GENERIC_DF_RATIO;
    if (!generic) out.push(term);
  }
  return out;
}

export interface PatchOptions {
  /** 最多给几条候选（一轮一条；默认 1 = 只补命中的那一个对话）。 */
  k: number;
  /** 单条补丁（= 一轮原话）的字符预算。 */
  maxChars: number;
  /**
   * RCC 用的裁剪参数 —— 用来判断"命中的那一轮**到底有没有被砍掉**"。
   *
   * 用户给的判据是：「如果**原话在被砍掉的对话里面**就注入一下」。
   * 所以"这场被裁过"是不够的：命中一个**看得见**的轮次再补一遍是白花预算，
   * 还会把真正被砍掉的命中挤出名额。
   */
  cut: CutOptions;
}

/**
 * 这一轮在 RCC 里**看得见吗**？
 *
 * 两层都要看：
 *  - 整场层面：落在头 `headTurns` 句或尾 `tailTurns` 句里 → 看得见；
 *  - 单条层面：那条发言自己没被 `cutMiddle` 裁过 → 看得见。
 * 只有**两层都看得见**才算"没被砍"，也就不值得补。
 */
function isVisibleInRcc(list: readonly TurnRow[], target: TurnRow, cut: CutOptions): boolean {
  const lines = list.filter((t) => t.userText.trim() !== '');
  const idx = lines.findIndex((t) => t.at === target.at);
  if (idx < 0) return true; // 找不到就当看得见（不补，宁可少补）
  const headN = Math.max(0, cut.headTurns);
  const tailN = Math.max(0, cut.tailTurns);
  const wholeKept = headN + tailN <= 0 || lines.length <= headN + tailN;
  const inKeptRange = wholeKept || idx < headN || idx >= lines.length - tailN;
  if (!inKeptRange) return false;
  return !cutMiddle(lines[idx].userText.trim(), cut.head, cut.tail).truncated;
}

/**
 * 找这一轮该补哪几**轮**原话。
 *
 * 候选范围**天然收敛在 RCC 覆盖范围内** —— 范围外的场没有"在 RCC 里被裁"这回事，
 * 补了也无处安放。所以不需要给原文建倒排索引，直接在 `turns` 表上现算。
 *
 * 三道闸门，缺一不可：
 *  1. 命中的词得有**辨识度**（泛词单独命中不算，见 `distinctiveTokens`）；
 *  2. 那一轮在 RCC 里**看不见**（看得见的已经完整在上下文里）；
 *  3. 该场被裁过（`sessions.rcc_truncated`）。
 *
 * 补的正文**就是那一轮**（用户 2026-09-17：「不是补整场对话啊，是触发关键词的那一个对话」）
 * —— 一开始实现成"整场完整原文"，实测一轮能端上来 2k+ 字符，而他要的只是那句话说全。
 *
 * 返回**候选**而不是"最终要补的"：去重账本在注入层（那是会话状态），这里只负责算分。
 */
export function patchCandidates(
  db: DatabaseSync,
  query: string,
  opts: PatchOptions,
): RccPatch[] {
  const covered = listSessions(db, { inRccOnly: true });
  const cutIds = new Set(covered.filter((s) => s.rccTruncated).map((s) => s.session));
  if (cutIds.size === 0) return [];

  const turns = listTurns(db).filter((t) => cutIds.has(t.session) && t.userText.trim() !== '');
  if (turns.length === 0) return [];

  // 闸门 ①：整句话都是泛词（"记忆"这种）→ 这一轮不补，连榜都不必排
  const distinctive = distinctiveTokens(query, turns);
  if (distinctive.length === 0) return [];

  const order = new Map(covered.map((s, i) => [s.session, i + 1]));
  const rows = new Map(covered.map((s) => [s.session, s]));
  const bySession = new Map<string, TurnRow[]>();
  for (const t of turns) {
    const list = bySession.get(t.session) ?? [];
    list.push(t);
    bySession.set(t.session, list);
  }

  const out: RccPatch[] = [];
  const seenTurns = new Set<string>();
  // 多取候选再筛：一部分命中会因"看得见"或"靠泛词"被丢掉，所以不能只取 k 个
  for (const hit of rankTurns(query, turns, opts.k * 8)) {
    const sid = hit.turn.session;
    const line = hit.turn.userText.trim();
    // 闸门 ①：这一轮得含有辨识度的词 —— 否则它是靠"记忆"这类泛词上榜的
    const tokens = new Set(tokenize(line));
    if (!distinctive.some((t) => tokens.has(t))) continue;
    // 闸门 ②：只补"被砍掉的原话" —— 看得见的那部分已经完整在上下文里了
    if (isVisibleInRcc(bySession.get(sid) ?? [], hit.turn, opts.cut)) continue;
    const key = `${sid}#${hit.turn.turn}`;
    if (seenTurns.has(key)) continue;
    seenTurns.add(key);
    const row = rows.get(sid);
    const list = bySession.get(sid) ?? [];
    const no = order.get(sid) ?? 1;
    const label = `${no}. ${sessionStamp(row?.startedAt ?? null)} ${sessionTitle(
      row ?? { session: sid, title: null, startedAt: null, inRcc: true, rccTruncated: true },
      list,
    )} · 第${hit.turn.turn}轮`.trim();
    // 补的是**这一轮的完整原话**；只有它自己超了预算才兜一次底 ——
    // **兜底也是掐中段**（按 60:40 拆上限），不是把尾巴砍光。
    const cap = splitCap(opts.maxChars);
    const body = cutMiddle(line, cap.head, cap.tail).text;
    out.push({ key, label, text: renderPatch(label, body) });
    if (out.length >= opts.k) break;
  }
  return out;
}
