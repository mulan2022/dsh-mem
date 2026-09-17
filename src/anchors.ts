/**
 * 来源锚点（设计文档 §5.5）。
 *
 * 为什么每条记忆都必须能回到它的出生地：一条记忆值不值得信，取决于它当时
 * 是在什么语境下说出来的。**没有锚点的断言在这套引用体系里是断链的** ——
 * 所以宁可拒绝入库，也不留一条查不到出处的记忆。（工具层据此拒绝写入。）
 *
 * 存放：`<vault>/raw/anchors.jsonl`，一行一条，只追加不重写。
 *
 * **为什么是旁挂文件，而不是把锚点表内嵌在 observations.md 里**：
 * 一条记忆会从 `observations.md` 晋升到 `sections/` 或 `entities/`。
 * 内嵌的话，锚点表得跟着正文一起搬家，搬漏一次就断链；
 * 旁挂的话 id 是 vault 内全局稳定号，正文带着 `[^12]` 走到哪都认得出，
 * 锚点表一动不动。搬家这件事因此变得**不可能出错**，而不是"记得要一起搬"。
 */
import { readVaultFile, writeVaultFile } from './vault.js';

export interface Anchor {
  /** vault 内唯一的递增号。一旦分配不再复用（复用会让旧引用指错人）。 */
  id: number;
  /** 会话 id。 */
  session: string;
  /** 轮次号（会话内递增）。 */
  turn: number;
  /** 记录时刻（ISO 8601）。 */
  at: string;
  /** 这条锚点记的是什么类型的写入（observe / instruction / …）。 */
  kind: string;
}

/** 锚点表在 vault 内的相对路径。放在 raw/ —— 它本来就是"未加工的原始素材"。 */
export const ANCHORS_FILE = 'raw/anchors.jsonl';

/** 断言角标写法：`[^12]`。与脚注语法一致，渲染器天然认。 */
export function renderAnchorMarker(id: number): string {
  return `[^${id}]`;
}

/** 时间线指针写法：`[→12]`。同一套 id，只是显示上更像"去看那一条"。 */
export function renderPointerMarker(id: number): string {
  return `[→${id}]`;
}

/**
 * 两种写法共用同一个解析器 —— 它们是**同一个 id 空间**的两种显示形式。
 * 拆成两套解析，迟早会让其中一处漏掉（同型的跟头本项目已经栽过）。
 */
const MARKER_RE = /\[\^(\d+)\]|\[→(\d+)\]/g;

/** 抽出文本里全部锚点号（按出现顺序）。 */
export function parseAnchorMarkers(text: string): number[] {
  const out: number[] = [];
  MARKER_RE.lastIndex = 0;
  for (let m = MARKER_RE.exec(text); m !== null; m = MARKER_RE.exec(text)) {
    out.push(Number(m[1] ?? m[2]));
  }
  return out;
}

/** 去掉角标，得到干净的正文（判重与检索都用它）。 */
export function stripAnchorMarkers(text: string): string {
  MARKER_RE.lastIndex = 0;
  return text.replace(MARKER_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/** 读整个锚点表（按 id 升序）。坏行跳过 —— 一行损坏不该让 vault 读不出来。 */
export function readAnchors(vaultDir: string): Anchor[] {
  const raw = readVaultFile(vaultDir, ANCHORS_FILE);
  if (raw === null) return [];
  const out: Anchor[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const id = typeof o.id === 'number' ? o.id : Number(o.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      out.push({
        id,
        session: typeof o.session === 'string' ? o.session : '',
        turn: typeof o.turn === 'number' && Number.isFinite(o.turn) ? o.turn : 0,
        at: typeof o.at === 'string' ? o.at : '',
        kind: typeof o.kind === 'string' ? o.kind : 'unknown',
      });
    } catch {
      /* 坏行跳过 */
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * 追加一条锚点，返回分配好的完整锚点。
 * 写入失败返回 null —— 调用方据此**拒绝把正文写进去**（宁可没记住，也不留断链）。
 */
export function appendAnchor(vaultDir: string, input: Omit<Anchor, 'id'>): Anchor | null {
  const existing = readAnchors(vaultDir);
  const id = existing.reduce((max, a) => Math.max(max, a.id), 0) + 1;
  const anchor: Anchor = { id, ...input };
  const cur = readVaultFile(vaultDir, ANCHORS_FILE) ?? '';
  const sep = cur.length > 0 && !cur.endsWith('\n') ? '\n' : '';
  const next = `${cur}${sep}${JSON.stringify(anchor)}\n`;
  return writeVaultFile(vaultDir, ANCHORS_FILE, next) ? anchor : null;
}

/** 按 id 取锚点。 */
export function findAnchor(anchors: readonly Anchor[], id: number): Anchor | null {
  return anchors.find((a) => a.id === id) ?? null;
}

/**
 * 锚点 → 详情文件相对路径（该种类没有外部详情时返回 null）。
 *
 * 这是「第一层粗粒度 + 指针 → 第二层详情按需取」里**唯一的取详情入口**：
 *  - `observe`：详情就是 `observations.md` 里它自己那行，没有外部文件；
 *  - `diff`：详情在 `raw/timeline/<id>.md`。
 *
 * 收敛成一个函数的意义：新增种类时不可能只改一半 —— 要么这里加上，
 * 要么调用方显式拒绝，不会出现"指针在、详情找不到"却没人管的情况。
 */
export function detailPathFor(a: Anchor): string | null {
  return a.kind === 'diff' ? `raw/timeline/${a.id}.md` : null;
}

/** 锚点的一行人类可读描述（写入工具回执与将来的"锚点重访"都用它）。 */
export function describeAnchor(a: Anchor): string {
  return `${a.session.slice(0, 8)} · turn ${a.turn} · ${a.at}`;
}
