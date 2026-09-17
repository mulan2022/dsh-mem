/**
 * 常驻记忆（设计文档 §2 的 A 层）。
 *
 * 与自动沉淀层（B 层）的区别：
 *  - 来源：**用户明确要求**记住的（"记住 X"），不是 AI 提炼出来的
 *  - 写入：**只能由 AI 通过工具写** —— 没有 HTTP 写接口，文件也不供人手动编辑
 *  - 注入：永久常驻，每次会话都在上下文里
 *  - 淘汰：**不参与 dream 淘汰** —— 自动整理按"重复/低价值"清库时，
 *    绝不能删掉用户明明白白交代过的事（那是事故，不是体验问题）
 *  - 上限：50 条，满了**拒绝新增并返回原因**，绝不静默淘汰最旧的
 *    （静默淘汰等于变相失忆）
 *
 * 存储：`<vault>/instructions.md`，每条一行 `- 内容`。
 * 用 markdown 是为了和 vault 其余部分一致、便于查看；但它是**机器维护**的文件，
 * 不是给用户手改的配置。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const INSTRUCTIONS_FILE = 'instructions.md';
export const MAX_INSTRUCTIONS = 50;

const HEADER = [
  '# 常驻记忆',
  '',
  '<!-- 本文件由 AI 通过 mem_remember / mem_forget 工具维护，**请不要手动编辑** ——',
  '     手工改动可能在下一次工具写入时被整段重写覆盖。',
  '     条目只在用户明确要求「记住 X」时才由 AI 添加。上限 50 条。',
  '     查看：DSH 设置 → 记忆空间 → 常驻记忆。 -->',
  '',
].join('\n');

export interface InstructionItem {
  /** 序号（1 起），仅用于展示 */
  index: number;
  text: string;
}

export interface InstructionFile {
  items: InstructionItem[];
  /** 是否已达上限 */
  full: boolean;
  max: number;
  path: string;
}

function filePath(vaultDir: string): string {
  return join(vaultDir, INSTRUCTIONS_FILE);
}

/** 确保文件存在（只在缺失时写表头，不覆盖用户内容）。 */
export function ensureInstructionsFile(vaultDir: string): void {
  const p = filePath(vaultDir);
  if (existsSync(p)) return;
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(p, `${HEADER}\n`, 'utf8');
}

/**
 * 解析常驻记忆文件。
 *
 * 只认 `- ` / `* ` 开头的行；标题、HTML 注释、空行、普通段落一律忽略。
 * 宽容解析是刻意的：用户手改文件时不该因为多写一行说明就报错。
 */
export function parseInstructions(text: string): InstructionItem[] {
  const items: InstructionItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('<!--') || line.startsWith('-->') || line.startsWith('<!--')) continue;
    const m = /^[-*]\s+(.*)$/.exec(line);
    if (!m) continue;
    const body = m[1].trim();
    if (!body) continue;
    items.push({ index: items.length + 1, text: body });
  }
  return items;
}

function serialize(items: readonly string[]): string {
  const lines = items.length ? items.map((t) => `- ${t}`) : ['<!-- 还没有常驻记忆。在记忆空间里添加，或直接编辑本文件。 -->'];
  return `${HEADER}\n${lines.join('\n')}\n`;
}

export function readInstructions(vaultDir: string): InstructionFile {
  ensureInstructionsFile(vaultDir);
  let text = '';
  try {
    text = readFileSync(filePath(vaultDir), 'utf8');
  } catch {
    text = '';
  }
  const items = parseInstructions(text);
  return { items, full: items.length >= MAX_INSTRUCTIONS, max: MAX_INSTRUCTIONS, path: filePath(vaultDir) };
}

/** 把内容规范成单行（常驻记忆每条一行，换行会破坏文件结构）。 */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export type AddResult =
  | { ok: true; file: InstructionFile }
  | { ok: false; reason: 'empty' | 'duplicate' | 'full'; file: InstructionFile };

/**
 * 新增一条常驻记忆。
 *
 * 满 50 条时**拒绝并返回 full**，不淘汰最旧的 —— 见文件头注释。
 */
export function addInstruction(vaultDir: string, text: string): AddResult {
  const body = oneLine(text);
  const current = readInstructions(vaultDir);
  if (!body) return { ok: false, reason: 'empty', file: current };
  if (current.items.some((it) => it.text === body)) {
    return { ok: false, reason: 'duplicate', file: current };
  }
  if (current.items.length >= MAX_INSTRUCTIONS) {
    return { ok: false, reason: 'full', file: current };
  }
  const next = [...current.items.map((it) => it.text), body];
  writeFileSync(filePath(vaultDir), serialize(next), 'utf8');
  return { ok: true, file: readInstructions(vaultDir) };
}

export type RemoveResult =
  | { ok: true; file: InstructionFile }
  | { ok: false; reason: 'not-found'; file: InstructionFile };

/**
 * 按内容删除一条。用内容而非下标定位 —— 下标会随增删漂移，
 * 前端与宿主之间传来传去容易删错条目。
 */
export function removeInstruction(vaultDir: string, text: string): RemoveResult {
  const body = oneLine(text);
  const current = readInstructions(vaultDir);
  const kept = current.items.map((it) => it.text).filter((t) => t !== body);
  if (kept.length === current.items.length) {
    return { ok: false, reason: 'not-found', file: current };
  }
  writeFileSync(filePath(vaultDir), serialize(kept), 'utf8');
  return { ok: true, file: readInstructions(vaultDir) };
}
