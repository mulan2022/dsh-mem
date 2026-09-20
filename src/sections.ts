/**
 * `sections.yaml` 的极小解析器。
 *
 * 刻意不引 YAML 依赖：这是我们**自己定义并自己写**的文件格式，
 * 形状非常规整。为读几个标量引入完整 YAML 解析器不划算。
 * 代价是格式必须保持规整 —— 模板与文档里都写明了这一点。
 *
 * 支持形状：
 *   key: value
 *   sections:
 *     - name: 显示名
 *       file: sections/x.md
 *       resident: true
 *       order: 10
 *       window: current-month      # 可选，见 SectionWindow
 *       hint: 一句话说明
 */

/**
 * 一节是不是"按月滚动"的窗口。
 *
 * 这是**声明式**的：写在这里，宿主代码就按它办事 —— 而不是靠 dream agent 记得去做。
 *  - `current-month` 「本月」：只该有当前这个月的小节，更早的整块被代码滚出去。
 *  - `month-archive` 「早期月份」：滚动落点。
 *
 * 判据是确定的（今天几号 vs 小节标题里的月份），所以**归代码管**；
 * agent 只负责把标题写成 `## YYYY-MM…`（它唯一需要保证的格式）。
 */
export type SectionWindow = 'current-month' | 'month-archive';

export interface SectionSpec {
  name: string;
  file: string;
  resident: boolean;
  order: number;
  window?: SectionWindow;
  hint: string;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** 解析 section 列表。解析不出任何一项时返回空数组（调用方自行兜底）。 */
export function parseSectionsYaml(text: string): SectionSpec[] {
  const out: SectionSpec[] = [];
  let cur: Partial<SectionSpec> | null = null;
  let inSections = false;

  const flush = () => {
    if (cur && cur.name && cur.file) {
      out.push({
        name: cur.name,
        file: cur.file,
        resident: cur.resident ?? false,
        order: cur.order ?? 999,
        ...(cur.window === undefined ? {} : { window: cur.window }),
        hint: cur.hint ?? '',
      });
    }
    cur = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    // 整行注释与空行跳过（但空行不结束当前项，允许项内空行）
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    if (/^#/.test(line.trim())) continue;

    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      inSections = /^sections\s*:/.test(body);
      if (!inSections) flush();
      continue;
    }
    if (!inSections) continue;

    if (body.startsWith('- ')) {
      flush();
      cur = {};
      const rest = body.slice(2);
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(rest);
      if (m) assign(m[1], m[2]);
      continue;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(body);
    if (m) assign(m[1], m[2]);
  }
  flush();
  return out.sort((a, b) => a.order - b.order);

  function assign(key: string, value: string): void {
    if (!cur) cur = {};
    switch (key) {
      case 'name':
        cur.name = unquote(value);
        break;
      case 'file':
        cur.file = unquote(value);
        break;
      case 'resident':
        cur.resident = /^true$/i.test(unquote(value));
        break;
      case 'order': {
        const n = Number(unquote(value));
        cur.order = Number.isFinite(n) ? n : 999;
        break;
      }
      case 'window': {
        const w = unquote(value);
        if (w === 'current-month' || w === 'month-archive') cur.window = w;
        break;
      }
      case 'hint':
        cur.hint = unquote(value);
        break;
      default:
        break;
    }
  }
}

/** 为一个 section 生成初始文件内容（仅在文件不存在时写入）。 */
export function seedSectionFile(spec: SectionSpec): string {
  const head = spec.hint ? `<!-- ${spec.hint} -->\n\n` : '';
  return `${head}# ${spec.name}\n\n_尚未有内容。dream 会在确证后填入。_\n`;
}

/** observations.md / log.md 的初始骨架。 */
export function seedObservations(): string {
  return [
    '# 待确证观察（暂存区）',
    '',
    '信号还不够强、只出现过一次、尚未被证实的观察写在这里。',
    '',
    '**本文件的内容不会被主动注入上下文**，也不会进 `README.md`。',
    '后续 dream 若发现某条被反复印证，会把它晋升到 `sections/` 或 `entities/`。',
    '',
    '---',
    '',
  ].join('\n');
}

export function seedLog(): string {
  return ['# Dream 日志', '', '每次整理的分阶段记录。vault 不健康时会明确写出来。', '', '---', ''].join('\n');
}

// ── 跨月滚动（代码做，不是 agent 做）────────────────────────────────────────

/** 一个 `## …` 小节。`month` 从标题开头的 `YYYY-MM` 解出；解不出就是空串（不动它）。 */
interface MonthBlock {
  month: string;
  /** 整块原文，含标题行。 */
  text: string;
}

export interface MonthRolloverResult {
  current: string;
  archive: string;
  /** 被滚走的小节（空数组表示什么都没做）。 */
  moved: Array<{ month: string; heading: string }>;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 把正文切成「首个 `##` 之前的前言」+ 若干 `##` 块。 */
function splitMonthBlocks(text: string): { head: string; blocks: MonthBlock[] } {
  const head: string[] = [];
  const blocks: MonthBlock[] = [];
  let heading: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (heading === null) return;
    const m = /^(\d{4})-(\d{2})/.exec(heading.trim());
    blocks.push({ month: m ? `${m[1]}-${m[2]}` : '', text: body.join('\n') });
    heading = null;
    body = [];
  };

  for (const line of text.split('\n')) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[1] ?? '';
      body = [line];
      continue;
    }
    if (heading === null) head.push(line);
    else body.push(line);
  }
  flush();
  return { head: head.join('\n'), blocks };
}

function trimBlank(s: string): string {
  return s.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

/**
 * 把「本月」里**不属于当前月**的小节整块滚进「早期月份」。
 *
 * 为什么这件事必须是代码：判据完全确定（今天几号 vs 小节标题里的月份），
 * 交给 agent 只会在它"想得起来"的时候发生 —— 于是「本月」越堆越长，
 * 注入的上下文里长期挂着几个月前的事，还白占预算。
 *
 * 行为：
 *  - 标题以 `YYYY-MM` 开头的块：月份 ≠ 当前月 → 滚走；月份 == 当前月 → 留下。
 *  - 标题不以 `YYYY-MM` 开头的块（含首个 `##` 之前的前言）：**一律留下** ——
 *    认不出月份就不动，宁可少搬也不搬错。
 *  - 滚出去的块**原样追加**到归档末尾（不重写标题、不合并同名月），保证无损；
 *    原文件按时间正序，追加后归档仍是正序。
 *
 * 纯函数：不碰文件系统，冒烟测试直接喂字符串。
 */
export function rolloverMonths(
  currentText: string,
  archiveText: string,
  now: Date,
): MonthRolloverResult {
  const thisMonth = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  const { head, blocks } = splitMonthBlocks(currentText);

  const stay: MonthBlock[] = [];
  const move: MonthBlock[] = [];
  for (const b of blocks) {
    if (b.month !== '' && b.month !== thisMonth) move.push(b);
    else stay.push(b);
  }
  if (move.length === 0) {
    return { current: currentText, archive: archiveText, moved: [] };
  }

  const currentOut = `${trimBlank([head, ...stay.map((b) => b.text)].join('\n'))}\n`;
  const movedText = move.map((b) => trimBlank(b.text)).join('\n\n');
  const base = trimBlank(archiveText);
  const archiveOut = base === '' ? `${movedText}\n` : `${base}\n\n${movedText}\n`;

  return {
    current: currentOut,
    archive: archiveOut,
    moved: move.map((b) => ({
      month: b.month,
      heading: (b.text.split('\n')[0] ?? '').replace(/^##\s*/, '').trim(),
    })),
  };
}
