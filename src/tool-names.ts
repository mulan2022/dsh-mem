/**
 * 工具名常量。
 *
 * 为什么单独成一个叶子模块：**「定义工具」和「识别工具调用」是两件事**。
 * `tools.ts` 需要名字来注册，`reflect.ts` 需要名字来判断"本轮是不是已经记过了"。
 * 把常量放在 tools.ts 里让 reflect.ts 去 import，就会埋下一条
 * tools → reflect → tools 的环；常量放这里，两边都只依赖它。
 *
 * 与参考实现的命名刻意错开：它用 `memory_*`，我们用 `mem_*`。
 * 两个记忆插件同时装上时，工具名不冲突 —— 这是可以共存的硬条件。
 */
export const TOOL_REMEMBER = 'mem_remember';
export const TOOL_FORGET = 'mem_forget';
export const TOOL_ENTITY = 'mem_entity';
export const TOOL_OBSERVE = 'mem_observe';
export const TOOL_DIFF = 'mem_diff';
export const TOOL_SEARCH = 'mem_search';
export const TOOL_SPACE = 'mem_space';
export const TOOL_DREAM = 'mem_dream';
