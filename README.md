# dsh-mem

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**跨会话记忆插件**。

**markdown 文件是唯一事实源，SQLite 只是可随时重建的派生索引。**
记忆是长期资产 —— 该能手改、能 git、能备份、能看懂，不该锁在二进制库里。
任何时候删掉 `index.db` 都不丢数据。

- 记忆数据：`<dsh home>/.dsh-mem/`（默认 `~/.dsh/.dsh-mem/`）
- 记忆空间 UI：DSH 设置页里的「**记忆空间**」分区
- 工具：`mem_*`（与同类插件的 `memory_*` 刻意错开，可以共存）

---

## ✨ 功能

### 聊天 / 项目两套记忆空间

两边记的**不是一回事**，所以分成两套、各自有 `sections.yaml`：

| 空间 | 记什么 |
| --- | --- |
| **聊天记忆** | 价值观、态度、沟通风格、偏好、关系 |
| **项目记忆** | 目标、待办、架构、决策、踩坑、时间线、实体 |

一个工作目录算哪边，判定顺序是（**前者压过后者**）：

```
agent preset（id === 'chat' → 聊天空间）
  →  登记表（workspaces.yaml）
  →  仓库标记（默认 .git）
  →  default（ask / chat / project）
```

**preset 是用户声明的意图**：给会话挂「聊天模式」preset 就是聊天空间，其余任何 preset
一律走项目空间（分区按 cwd 推导）。登记表可以手改，也可以让 AI 用 `mem_space` 登记。

**项目之间硬隔离**：每个项目一个分区，**其它项目的记忆永远不会主动进上下文**，
只有 AI 主动 `mem_search` 才搜得到（结果带归属标注）。
隔离由代码结构保证，不靠调用方记得过滤。

### 聊天模式：RCC 原文召回 + 记忆注入

会话挂「聊天模式」preset 时，自动注入三样东西：

1. **常驻记忆 + 全局共用** —— 身份、AI 设定、准则、能力画像、技术栈偏好
2. **聊天记忆** —— 价值观 / 态度 / 沟通风格等 section + 实体目录
3. **RCC** —— 你最近 **40 场**对话里**自己的全部发言**，逐字引用、不加摘要、不做检索

RCC **只留你说的、不留 AI 的**。超长就掐中段（头 60 字 + 尾 40 字），一场只留头 12 句 ——
但**掐掉的部分能在命中时补回来**：每轮拿你的话做一次 BM25，命中且那一段确实被
`[TL;DR]` 遮住了，就把那一轮完整原话追加一条。所以"被裁"不等于"丢了"。

两道闸门防误触发：query 里得有**有辨识度的词**（`记忆`、`这个` 这类高 df 泛词不算），
且命中的那轮在 RCC 里**确实被遮住了**（看得见的已经完整在上下文里，再补一遍是白花预算）。

成本：**15–20k token**（参照：Kimi 那边光上下文注入要 40k 左右）。
项目会话**不挂 RCC** —— 项目里已经有时间线那套，再挂一个是同一个问题两个答案。

### 项目模式：改动都记在账上，但平时不占上下文

**项目记忆（包括当前项目）一律不主动注入正文**。项目会话只给**一行轻量指针**
（"你在项目 X 里，它的记忆不在你的上下文里，用 `mem_search` / `mem_entity` / `mem_diff` 取"）；
其它项目再多给一行规模（"它有 12 条记忆、3 条时间线"）。正文由 AI 需要时自己取。

**项目时间线**是这里最实用的一块 —— `write` / `edit` 本来就把 diff 附在结果上，直接抄下来：

```
tools/result（带 meta.diffs）
   │ 按会话缓冲，轮次结束时聚合
   ▼
timeline.md           一轮一行摘要 + [→id] 指针
   │ [→id]
raw/timeline/<id>.md  完整改前 / 改后（永不主动注入）
```

- 摘要按**轮**记而不是按工具调用记 —— 否则一场重构能写下几十行、直接把上下文吃光
- 详情要 AI 判断"这次改动还影响现在"时才用 `mem_diff` 翻开
- **只采集带 diff 的工具结果**，外加 write/edit/move/delete 这类改动类工具的调用记录；
  命令行里**间接**改的文件不采集（收进来会让时间线变成命令流水账）

### dream：晚上统一整理

**白天不写记忆**。对话里只做两件事：用户明说「记住 X」时提一句、把每轮原文存进素材池。
真正的整理放在**每晚 03:00** 检查一次：

- 一天只跑一次；最近 15 分钟有活动就推迟；**没素材直接跳过**，不烧钱；成功后冷却 6 小时
- **每个会话派两个子 agent**（一个管闲聊、一个管项目），读**同一份**素材各捞各的
  —— 按会话切切不出空间，一个项目目录里的闲聊也该归进聊天记忆
- 阶段 A 两批 agent **只读不写**、只吐 JSON；收齐后阶段 B **唯一写者**落库并回**回执 JSON**
  （不信口头汇报）
- 出错释放租约、冷却后重试 —— 一次断网不会永久吞掉一晚的整理

素材池刻意是**未归属**的（`raw/turns/<会话>.jsonl`）：按目录预先分好等于替 agent 把归属判完了。

`mem_dream` 可以手动跑：`status` 看有哪些会话待整理 / `run` 现在整理 / `skip` 跳过。
**「跳过整理」只挡自动整理**，手动 `run` 照样整理它。

### 常驻记忆（A 层）

`shared/instructions.md`，每条一行，**上限 50 条**。唯一写入口是 AI 工具
`mem_remember` / `mem_forget` —— 没有 HTTP 写接口、UI 只读、文件不供手改。
写满会明确报错说明原因，**绝不静默淘汰最旧的**。

### 三层置信度 + 来源锚点

```
raw/                 原始素材（每轮对话原文）        ← 从不注入
  ↓ dream 提炼
observations.md      暂存：信号弱、未确证             ← 不注入、不进 README
  ↓ dream 确证
sections/ entities/  确证：参与常驻注入
```

每条 observation 都必须带**来源锚点**（`[^N]` ↔ `raw/anchors.jsonl` 里的 `{session, turn, at}`）。
**锚点写不进去，正文就不写** —— 查不到出处的记忆不如不记。

锚点表**旁挂**而不内嵌：一条记忆从 `observations.md` 晋升到 `sections/` 时，
`[^12]` 跟着正文走，锚点表一动不动，搬家不可能出错。

### 记忆空间 UI

DSH 设置页里的「记忆空间」分区，**3 个 tab 对应三样东西**：
`常驻记忆` / `聊天记忆` / `项目记忆`。

项目记忆是**一个** tab、**不随项目数增长** —— 下面是 `projects/<项目名>/`，在右侧文件树点进去。
正文里的 `[[实体名]]` 渲染成可点击链接，点了跳到那一页（不靠猜文件名）。

### 全程可开关

总开关 + 每一块都能单独关（注入 / 采集 / 时间线 / dream / RCC）。
**关闭不删除任何 vault 文件。**

---

## 📦 安装

> ⚠️ **不要用 `dsh plugin add dsh-mem`** —— npm 上那个 `dsh-mem` 是**别人写的另一个插件**。
> 本插件请从 GitHub 源安装。

### 一键安装（推荐）

```sh
dsh plugin --profile web add github:mulan2022/dsh-mem
```

装完即生效（安装时自动构建，包内含 `prepare` 脚本），重启 `dsh web` 后新会话自动加载。

> pnpm ≥10 默认会拦安装期的构建脚本：首次 `add` 可能失败并提示 `allowBuilds`，
> 按提示把输出的键加进 profile 的 `pnpm-workspace.yaml` 后重跑即可。

构建只需要**这台机器上装了 dsh** —— `@deepseek-ai/*` 直接从 dsh 自己的安装位置取，
不需要 pnpm workspace，也不依赖 PowerShell，Windows / macOS / Linux 都一样。

### 手动安装（开发者）

软链安装最方便：**改源码就是改运行代码**。

1. 把仓库放进 profile 的 `node_modules`：

   ```sh
   git clone https://github.com/mulan2022/dsh-mem ~/dsh-mem
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -s ~/dsh-mem ~/.dsh/profiles/web/node_modules/dsh-mem
   ```

   Windows 用 NTFS junction（不需要管理员权限）：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-mem" `
     -Target "C:\path\to\dsh-mem"
   ```

2. 在插件目录安装依赖并构建：

   ```sh
   cd ~/dsh-mem && npm install && npm run build
   ```

3. 把 `dsh-mem` 加进 profile `package.json` 的 `dsh.profile.bundles`。
4. 重启 `dsh web`。用 `dsh --profile web --dump-config` 可以确认 `# == dsh-mem` 那一层挂上了。

### 启用聊天模式（想用聊天记忆就装）

**聊天空间靠 preset 身份判定** —— 没有 id 为 `chat` 的 preset，聊天记忆就永远进不去
（会话会被当成项目）。仓库里带了一份可直接用的：

```sh
mkdir -p ~/.dsh/.agent-presets/chat
cp presets/chat/preset.yml presets/chat/agent.cordis.yml ~/.dsh/.agent-presets/chat/
```

Windows PowerShell：

```powershell
$dst = "$env:USERPROFILE\.dsh\.agent-presets\chat"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item presets\chat\* $dst -Force
```

重启 `dsh web`，新建会话时选「**聊天模式**」。它会拿到：记忆空间（`mem_*`）+ 技能目录 +
shell 与文件读写（聊着聊着丢个文件过来也能看），并且**每场对话注入最近 40 场的你自己
说过的原话**。

> 这份 preset 是**可改的起点**，不是唯一答案：`agent.cordis.yml` 里逐行写了"给什么、
> 刻意不给什么、想加照哪个写法复制"。preset 的 id 取自**目录名**，所以目录必须叫 `chat`。

### 卸载

```sh
dsh plugin --profile web remove dsh-mem
```

**记忆数据不会被删** —— 它在 `~/.dsh/.dsh-mem/`，独立于插件安装位置。要清得自己删目录。

---

## ⚙️ 配置

字段全部可选。改 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-mem
  name: 'dsh-mem'
  config:
    enabled: true            # 总开关
    home: ''                 # dsh home 覆盖；空串 = DSH_HOME → ~/.dsh
    projectRootMarkers: ['.git']
    promptLang: 'zh'
    injectMaxChars: 2000     # 单次记忆注入的字符预算
    entityMaxChars: 3000     # 单次实体命中的字符预算
    autoWrite: true          # 「用户明说记住」时的提醒
    captureTurns: true       # 原始轮次采集（dream 的前提，关掉 dream 就无米下锅）
    timeline: true           # 项目时间线
    diffMaxChars: 6000       # mem_diff 单次返回预算
    dream: true
    dreamAt: '03:00'         # 每晚什么时候检查（HH:MM，本地时间）
    dreamIdleMinutes: 15     # 最近多少分钟有活动就推迟
    dreamCooldownHours: 6    # 成功后多久内不再跑
    rcc: true                # 聊天原文召回
    rccSessions: 40          # 覆盖多少场（单位是场，不是消息）
    rccHeadTurns: 12         # 一场只留头 N 句
    rccTailTurns: 0          # 一场留尾 N 句（默认 0）
    rccHeadChars: 60         # 单条发言留头 N 字
    rccTailChars: 40         # 单条发言留尾 N 字
    rccMaxChars: 40000       # 整块预算；超出从最旧的场开始丢
    rccPatchK: 1             # 一轮最多补几段原文
    rccPatchChars: 4000      # 单条补丁的字符预算
```

> id 定向补丁会**整段替换**该行的 config、而不是深合并 —— 要保留的键必须重述。

---

## 🧰 工具

| 工具 | 干什么 |
| --- | --- |
| `mem_remember` / `mem_forget` | 常驻记忆（上限 50 条）。**只有用户明确要求时才用** |
| `mem_observe` | 记一条待确证观察。工具说明第一句就是「不要在对话过程中主动记东西」 |
| `mem_search` | 跨项目检索，结果带归属标注（词频饱和 × 查询覆盖率 × 长度惩罚 + 名字加成） |
| `mem_entity` | 翻实体页，返回正文 + 一跳邻居（邻居只给名字） |
| `mem_diff` | 取某条时间线改动的**完整改前 / 改后**（`[→id]` 那道门） |
| `mem_dream` | 手动整理：`status` / `run` / `skip` / `unskip` |
| `mem_space` | 登记工作区类型（**只在用户明确表态时**） |

**落点不由调用方决定**：工具签名里**没有**"写去哪个空间"这个参数，落点由当前会话的
workspace 硬推导 —— 调用方没有机会写错地方。

检索用 **CJK bigram + Unicode 整词**分词（中文没有词边界，这是绕开 FTS5 把整串中文
当一个 token 的实测结论）。**这是第一版够用的量级，不是调过的**。

---

## 开发

```sh
npm install        # 依赖 + 自动构建（prepare）
npm run build      # esbuild → lib/（宿主 bundle + 客户端 bundle）
npm run watch      # 监听重建
npm run typecheck  # tsc --noEmit
npm run check      # 冒烟测试（临时 home，不碰真实数据）
npm run link       # Windows：建 @deepseek-ai junction 镜像（只有 typecheck 需要）
```

- **提示词外置**在 `prompts/`（`dream-extract-chat.md` / `dream-extract-project.md` /
  `dream-merge.md`），改文案不用重新构建。三份各自自包含。
- 改了字符串要重新 `npm run build`；只改注释或类型不必。
- `@deepseek-ai/*` 只在**构建期**需要：先找本地 `node_modules/`，找不到就回退到
  dsh 安装位置里的那一份。

### 状态

| 阶段 | 状态 |
| --- | --- |
| vault 约定 + 派生索引 + 数据面路由 + 记忆空间 UI | ✅ |
| 常驻记忆 A 层（工具唯一写入） | ✅ |
| 注入（静态手册 + 常驻记忆，每会话一次，压缩后重注） | ✅ |
| 实体三档信息量（开局给名字目录 → 按需翻正文 → 双链可点击） | ✅ |
| 自动写入 + 来源锚点 | ✅ |
| 项目时间线（抄 diff → 一轮一行摘要 + 详情按需取） | ✅ |
| 分区隔离与跨项目检索 | ✅ |
| 空间收敛（跨项目层并入 shared；项目记忆整体不注入） | ✅ |
| 聊天 / 项目按 agent preset 分空间 | ✅ |
| RCC 聊天原文召回 + 补丁 | ✅ |
| dream（调度内核 + 两段式编排 + `mem_dream` 工具） | ✅ 手动可用 |
| dream 的**每晚定时路径**、会话右键菜单「跳过整理」 | ⏳ |
| 40 轮窗口铁律 / 三层晋升与冲突规则 / 递归压缩 / 锚点重访 / 检索测评集 | ⏳ |

---

## 设计说明

- **为什么 vault 是事实源、SQLite 只是派生索引**：二进制库坏一次就全没了，
  而记忆是长期资产；派生索引随时可以重建。
- **为什么开局只给标题**：目录便宜、正文贵。开局给常驻记忆 + 实体名目录，
  提到哪个再翻哪个 —— 这就是"看到引用再去翻原文"。
- **为什么项目记忆不注入**：项目细节量大、多数时候用不上，全塞进上下文既贵又吵。
- **为什么 dream 派子 agent**：整理要读一大堆 `raw/`，放进主会话会污染当前对话；
  而且内容必须先过「观察 → 确证」这道关，所以 `entities/` 空着是设计使然、不是 bug。
- **为什么用子 agent 做唯一写者**：冲突靠结构解决，不靠 agent 自觉。
- **为什么聊天原文只留用户的**：AI 的回复是当时的表述、不是记忆；用户的话才是素材。

## 致谢

本插件的思路来自对 [**meow-memory**](https://github.com/Phant0Meow/dsh-meow-memory)（MIT）的阅读，
明确参考了这几处：

- **客户端插件骨架** —— `settings.section` / `slots` 的用法形态，改成 vault 浏览器
- **dream 调度骨架** —— 空闲触发、租约、冷却、失败释放重试
- **BM25 打分器规格** —— 公式与按记忆时间戳的衰减权重
- **一批真机事故的防御性修复** —— 它 CHANGELOG 里踩过的坑（dream 被一次断网吞掉窗口等）

**没抄的部分**（这些是本插件自己的设计）：提示词全部自写；存储模型不同 ——
它用七层 SQLite 当事实源，这里用 markdown vault；检索范式不同 —— 这里是
"vault 文档 + 实体名精确命中"，不上向量（实测 BM25 与向量融合无增益）。

工具名**刻意错开**（它 `memory_*`，这里 `mem_*`），两个记忆插件可以同时装上而不撞名。

## 许可

[MIT](LICENSE)
