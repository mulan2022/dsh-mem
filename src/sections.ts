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
 *       hint: 一句话说明
 */

export interface SectionSpec {
  name: string;
  file: string;
  resident: boolean;
  order: number;
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
