# Discussion post — “Show Your Plugins!”

准备贴到 <https://github.com/deepseek-ai/deepseek-harness/discussions/new?category=show-your-plugins>

**标题（英文版，推荐）：**

> dsh-mem — cross-session memory for DSH as a plain markdown vault (hard project partitions, no vector DB)

**标题备选：**

> dsh-mem — memory that lives in markdown files you can read and edit

**图片**：GitHub 的输入框不认本地路径。两种办法选一种 ——

1. 在编辑器里直接**把 `dsh-mem/docs/images/memory-space.png` 和 `chat-mode.png` 拖进正文**（GitHub 会自动上传，最稳）；
2. 或者用仓库里的 raw 链接（仓库得是公开的、图已 push 到 `main`）：
   `https://raw.githubusercontent.com/mulan2022/dsh-mem/main/docs/images/memory-space.png`

下面两版正文按需取用。英文版放前面，中文版在后面，**不要一起贴**。

---

## English version

**dsh-mem** gives DSH a memory that survives across sessions — stored as a plain markdown vault at `~/.dsh/.dsh-mem/`, not in a database you can't read.

![Memory space: resident / chat / project memory](https://raw.githubusercontent.com/mulan2022/dsh-mem/main/docs/images/memory-space.png)

### Install

```sh
dsh plugin --profile web add github:mulan2022/dsh-mem
```

Restart `dsh web`. That's it — no config file to write, no service to run.

> ⚠️ Chat memory only exists in **chat mode**. A session's memory space is decided by its **agent preset**, so the plugin ships the `chat` preset itself (a `@deepseek-ai/dsh-agent-preset` declaration in its bundle patch) — after a restart, pick 「聊天模式」for the conversations you want remembered. Project sessions get project memory instead.

### What it actually does

- **Two spaces, hard partitions.** Chat memory and project memory never bleed into each other. Which one a session belongs to is derived from the agent preset → workspace registry → repo marker (`.git` by default), in that order — enforced by the code path, not by asking callers to filter correctly.
- **Project memory is never injected.** A project session gets one pointer line telling it the memory exists and which tools read it. Details are large and noisy, so the model pulls them on demand via `mem_search` / `mem_entity` / `mem_diff`.
- **Change log for free.** Every `write` / `edit` diff is captured, summarized to one line per turn, with a pointer to the full before/after — readable only when a change still matters.
- **Nightly consolidation, incremental.** A session is read end-to-end once; the run leaves behind a summary, and later nights only get "that summary + the turns since". Cost drops from ~150–250k tokens on a full night to tens of thousands on an incremental one.
- **Resident memory is capped at 50 and tool-only.** Only `mem_remember` / `mem_forget` write it; the UI is read-only and nothing silently evicts your oldest entry — it fails loudly instead.
- **Everything is a toggle.** Injection, turn capture, timeline, consolidation and raw-chat recall are independent switches, and turning one off never deletes a file.

### Design choices worth mentioning

- **Markdown is the source of truth; `index.db` is a derived cache.** Delete the index and it rebuilds — nothing is lost. You can open the vault and edit it by hand.
- **No embeddings.** Retrieval is BM25 plus exact entity-name hits, with CJK bigram + Unicode word segmentation (FTS5 tokenizes a whole Chinese string as one token). Measured no gain from fusing a vector channel, so it isn't there.
- **No "which space do I write to" parameter.** Tool signatures don't take a destination; the landing spot is derived from the current session's workspace. A caller has no way to write to the wrong place.
- **Tool names are deliberately disjoint** from other memory plugins (`mem_*` vs `memory_*`), so two can coexist.

### DSH integration points

For anyone writing plugins — this uses `dsh.bundle.patch` (a `- insert:` row in `cordis.patch.yml`), `dsh.client.platform: 'web'` for the client half (a settings section through `slots`, plus session context-menu items), and on the host side `ctx.tools.register`, `ctx.systemPrompt.section`, `ctx.get('webServer').register` and session/agent events. The 「聊天模式」preset is that same patch's second insert row: a `@deepseek-ai/dsh-agent-preset` declaration (bundles carry presets; `~/.dsh/.agent-presets/` is gone as of 0.2). Everything under `@deepseek-ai/*` is build-time only; the shipped bundles are self-contained.

The manifest declares `dsh.manifestVersion: 1` and `engines.dsh`; built and verified against **0.2.0-rc.2** (message sources moved to per-producer `kind: 'plugin:dsh-mem'`), 0.1.6-alpha.2 and 0.1.5-rc.1.

### Tools

| Tool | What it does |
| --- | --- |
| `mem_remember` / `mem_forget` | Resident memory (cap 50). Only when the user says so |
| `mem_observe` | One pending observation; the description opens with "don't record things mid-conversation" |
| `mem_search` | Cross-project search with provenance and dates |
| `mem_entity` | Entity page body + one-hop neighbours (names only) |
| `mem_diff` | Full before/after of one timeline entry |
| `mem_dream` | `status` / `run` / `skip` / `unskip` |
| `mem_space` | Register a workspace type (only on an explicit user statement) |

### Status

Scheduled consolidation (the 03:00 path) isn't wired yet, so automatic runs are triggered manually through `mem_dream` or the session context menu. The 40-turn window rule, three-tier promotion and conflict resolution, recursive compaction, anchor revisits and a retrieval evaluation set are still open.

MIT. Ideas borrowed from [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) (client-plugin skeleton, scheduling skeleton, BM25 spec, defensive fixes from its changelog); prompts, vault design and tooling are my own. Feedback very welcome — especially on the retrieval scoring, which is first-pass and not yet tuned against data.

---

## 中文版

**dsh-mem** 给 DSH 加一层跨会话记忆 —— 事实源是 `~/.dsh/.dsh-mem/` 下的**普通 markdown 文件**，不是一个你打不开的数据库。

![记忆空间：常驻记忆 / 聊天记忆 / 项目记忆](https://raw.githubusercontent.com/mulan2022/dsh-mem/main/docs/images/memory-space.png)

### 装

```sh
dsh plugin --profile web add github:mulan2022/dsh-mem
```

重启 `dsh web` 即可。不用写配置文件，也不用另起服务。

> ⚠️ **聊天记忆只在「聊天模式」里有。** 一个会话属于哪个空间由它的 **agent preset** 决定 ——
> 所以「聊天模式」是随插件装的（本包 `cordis.patch.yml` 里一行 `@deepseek-ai/dsh-agent-preset`
> 声明），重启后新建会话时选它就行；项目会话走的是项目记忆。

### 它干什么

- **两个空间，硬隔离。** 聊天记忆和项目记忆互不串味。会话归哪边按「agent preset → 工作区登记表 → 仓库标记（默认 `.git`）」判定，由代码结构保证，不靠调用方自觉过滤。
- **项目记忆整体不注入。** 项目会话只拿一行指针，说明记忆在哪、用哪个工具取。项目细节量大又吵，正文由模型按需 `mem_search` / `mem_entity` / `mem_diff` 去翻。
- **改动自动记账。** `write` / `edit` 的 diff 全被抄下来，一轮一行摘要 + 指向前后完整内容的指针，等某次改动还影响现在时才去翻。
- **每晚整理，而且是增量的。** 一场会话只在第一次被整场读一遍并留下摘要，之后每晚只喂「那份摘要 + 之后新增的轮次」。成本从整场那晚的十几到二十几万 token，降到增量那晚的几万。
- **常驻记忆硬上限 50 条。** 只有 `mem_remember` / `mem_forget` 能写，UI 只读；写满会明确报错，绝不静默淘汰最旧的。
- **全都能关。** 注入、轮次采集、时间线、整理、原文召回各是独立开关，关掉不删任何文件。

### 几个设计取舍

- **markdown 是事实源，`index.db` 只是派生缓存。** 删掉索引它自己重建，什么都不丢；vault 可以直接打开手改。
- **不上向量。** 检索是 BM25 + 实体名精确命中，中文走 bigram + Unicode 整词切分（FTS5 会把整串中文当一个 token）。实测融合向量通道没有增益，所以没做。
- **工具签名里没有「写去哪个空间」。** 落点由当前会话的工作区硬推导，调用方没有机会写错地方。
- **工具名与别的记忆插件刻意错开**（`mem_*` vs `memory_*`），两个可以同时装。

### 与 DSH 的接缝

给同样写插件的人参考：用 `dsh.bundle.patch`（`cordis.patch.yml` 里一行 `- insert:`）、`dsh.client.platform: 'web'` 挂客户端半边（设置分区走 `slots`，会话右键菜单是 DOM 注入），宿主侧用 `ctx.tools.register`、`ctx.systemPrompt.section`、`ctx.get('webServer').register` 以及 session / agent 事件。`@deepseek-ai/*` 全部只在构建期需要，产物是自包含的。

「聊天模式」就是同一个补丁里的第二行：一行 `@deepseek-ai/dsh-agent-preset` 声明 —— **0.2 起 preset 只能由 bundle 带**，`~/.dsh/.agent-presets/` 目录已不再被读。

清单里声明了 `dsh.manifestVersion: 1` 与 `engines.dsh`；已在 **0.2.0-rc.2**（消息来源改成按产出方命名 `kind: 'plugin:dsh-mem'`）以及 0.1.6-alpha.2、0.1.5-rc.1 上构建并验证。

### 工具

| 工具 | 干什么 |
| --- | --- |
| `mem_remember` / `mem_forget` | 常驻记忆（上限 50 条）。只在用户明确要求时用 |
| `mem_observe` | 记一条待确证观察；工具说明第一句就是「不要在对话过程中主动记东西」 |
| `mem_search` | 跨项目检索，带归属标注与日期 |
| `mem_entity` | 翻实体页，返回正文 + 一跳邻居（邻居只给名字） |
| `mem_diff` | 取某条时间线改动的完整改前 / 改后 |
| `mem_dream` | `status` / `run` / `skip` / `unskip` |
| `mem_space` | 登记工作区类型（只在用户明确表态时） |

### 现状

每晚 03:00 的定时整理还没接线，自动整理现在靠 `mem_dream` 或会话右键菜单手动触发。40 轮窗口铁律、三层晋升与冲突规则、递归压缩、锚点重访、检索测评集也都还没做。

MIT。思路来自 [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)（客户端插件骨架、调度骨架、BM25 规格，以及它 CHANGELOG 里一批真机事故的防御性修复）；提示词、vault 设计与工具是自己写的。欢迎拍砖 —— 尤其是检索打分那一块，还是第一版，没拿数据调过。
