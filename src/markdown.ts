/**
 * markdown 列表的小工具 —— `observations.md` 与 `timeline.md` 共用。
 *
 * 为什么单独抽出来：这两个文件都是「按日期分组的一行一条 + 指针」，
 * 插入逻辑一模一样。各写一套的话，两边迟早会在"空行补几个"这类细节上分叉，
 * 而分叉的结果是其中一个文件被渲染成一坨（本项目已经踩过一次同类坑）。
 */

/** 本地日期 `YYYY-MM-DD`。按用户时区分组，不按 UTC —— 人看的是本地日期。 */
export function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 本地时间 `MM-DD HH:mm`（摘要行用的紧凑写法）。 */
export function localStamp(now: Date): string {
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 把一条 bullet 放进 `## <date>` 分组里；该分组不存在就在文件末尾新建。
 * 只插入，不重排、不动已有内容。
 */
export function insertUnderDate(text: string, date: string, bullet: string): string {
  const heading = `## ${date}`;
  const at = text.indexOf(`\n${heading}\n`);
  if (at < 0) {
    const base = text.endsWith('\n') ? text : `${text}\n`;
    return `${base}\n${heading}\n\n${bullet}\n`;
  }
  // 该分组的末尾 = 下一个 `## ` 之前；没有下一个就到文件尾。
  const after = text.indexOf('\n## ', at + 1);
  const insertAt = after < 0 ? text.length : after + 1;
  const before = text.slice(0, insertAt);
  const rest = text.slice(insertAt);
  const head = before.endsWith('\n') ? before : `${before}\n`;
  // 与下一个标题之间留一个空行：markdown 里列表紧跟标题会被并进列表项
  const tail = rest ? `\n${rest}` : '';
  return `${head}${bullet}\n${tail}`;
}

/**
 * 用一个不会与内容里反引号打架的围栏包住代码块。
 *
 * 详情里存的是源码，源码里本来就可能有三反引号（比如 README）——
 * 固定用三个反引号会把围栏提前闭合，把后面的内容渲染成正文。
 */
export function fenced(text: string): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}\n${text.replace(/\n+$/, '')}\n${fence}`;
}

/** 超长文本截断（详情文件不该无上限增长）。 */
export function clampText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，原长 ${text.length} 字符）`;
}
