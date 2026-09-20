# dsh-mem

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的跨会话记忆插件。

记忆就是一堆 markdown 文件，放在 `~/.dsh/.dsh-mem/`。你可以直接用编辑器打开改，也可以删掉
索引让它自己重建 —— **文件是唯一事实源，`index.db` 只是派生索引**，删了不丢东西。

## 装

```sh
dsh plugin --profile web add github:mulan2022/dsh-mem
```

重启 `dsh web` 即可。

> npm 上那个 `dsh-mem` 是别人写的另一个插件，**不要**用 `dsh plugin add dsh-mem`。

想用聊天记忆，再装一份 `chat` preset。聊天空间是按 preset 身份认的，没有它进不去
（会话会被当成项目）：

```sh
mkdir -p ~/.dsh/.agent-presets/chat
cp presets/chat/* ~/.dsh/.agent-presets/chat/
```

目录名必须是 `chat` —— preset 的 id 取自目录名。重启后新建会话时选「聊天模式」，
它会带着记忆空间 + 技能目录 + shell 与文件读写。

## 它记什么

**聊天和项目分开记。** 两边记的不是一回事：聊天记价值观、态度、沟通风格、和人的关系；
项目记目标、架构、决策、踩坑。一个会话算哪边，判定顺序是 agent preset → 工作区登记表 →
仓库标记（默认 `.git`）。

**项目之间互相看不见。** 别的项目的记忆永远不会主动进上下文，只有 AI 主动 `mem_search`
才搜得到，结果带归属标注。这条由代码结构保证，不靠调用方记得过滤。

**项目里的改动都记在账上。** `write` / `edit` 的 diff 被自动抄下来，一轮一行摘要加一个
指针，详情等 AI 判断"这次改动还影响现在"时才翻。项目会话只给一行提示说"你的记忆不在
上下文里，用工具取" —— 项目细节量大，全塞进去既贵又吵。

**聊天模式会带上你最近 40 场说过的原话。** 逐字引用、不摘要、只留你说的不留 AI 的。
单条太长就掐中段（头 60 字 + 尾 40 字），一场只留头 12 句 —— 但**掐掉的部分命中时能
补回来**，所以"被裁"不等于"丢了"。成本 15–20k token，只在聊天模式挂。

**整理在晚上做。** 对话中几乎不写记忆，只把每轮原文存进素材池。每晚 03:00 跑一次 dream：
每个会话派两个子 agent（一个管闲聊、一个管项目）读同一份素材各捞各的，再由唯一一个写者
落库。也可以从**会话右键菜单**点「现在整理记忆」立刻跑，点「跳过整理记忆」把它排除在
自动整理之外（手动触发不受影响）。

**常驻记忆上限 50 条**，只有 AI 能通过工具写（`mem_remember` / `mem_forget`），UI 只读、
文件不供手改。写满会明确报错，绝不静默淘汰最旧的。

**都能关。** 注入、轮次采集、时间线、dream、原文召回各是独立开关，关闭不删任何文件。

## 配置

字段全可选，写进 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-mem
  name: 'dsh-mem'
  config:
    enabled: true            # 总开关
    home: ''                 # dsh home 覆盖；空串 = DSH_HOME → ~/.dsh
    projectRootMarkers: ['.git']
    promptLang: 'zh'
    injectMaxChars: 8000     # 单次记忆注入的字符预算
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

> id 定向补丁是**整段替换**该行的 config、不是深合并 —— 要保留的键必须重述一遍。

## 工具

| 工具 | 干什么 |
| --- | --- |
| `mem_remember` / `mem_forget` | 常驻记忆（上限 50 条）。只在用户明确要求时用 |
| `mem_observe` | 记一条待确证观察。工具说明第一句就是「不要在对话过程中主动记东西」 |
| `mem_search` | 跨项目检索，带归属标注与日期 |
| `mem_entity` | 翻实体页，返回正文 + 一跳邻居（邻居只给名字） |
| `mem_diff` | 取某条时间线改动的完整改前 / 改后 |
| `mem_dream` | 手动整理：`status` / `run` / `skip` / `unskip` |
| `mem_space` | 登记工作区类型（只在用户明确表态时） |

工具签名里**没有**"写去哪个空间"这个参数 —— 落点由当前会话的工作区硬推导，调用方没有
机会写错地方。检索用 CJK bigram + Unicode 整词分词（中文没有词边界，这是绕开 FTS5 把整串
中文当一个 token 的实测结论）；打分还是第一版够用的量级，没拿数据调过。

## 开发

```sh
npm install        # 依赖 + 自动构建（prepare）
npm run build      # esbuild → lib/（宿主 bundle + 客户端 bundle）
npm run watch      # 监听重建
npm run typecheck  # tsc --noEmit
npm run check      # 冒烟测试（临时 home，不碰真实数据）
npm run link       # Windows：建 @deepseek-ai junction 镜像（只有 typecheck 需要）
```

提示词外置在 `prompts/`（`dream-extract-chat.md` / `dream-extract-project.md` /
`dream-merge.md`），改文案不用重新构建。改了字符串要重新 `npm run build`，只改注释或类型
不必。`@deepseek-ai/*` 只在构建期需要：先找本地 `node_modules/`，找不到就回退到 dsh 安装
位置里的那一份。

### 手动安装

软链最方便 —— 改源码就是改运行代码。

```sh
git clone https://github.com/mulan2022/dsh-mem ~/dsh-mem
mkdir -p ~/.dsh/profiles/web/node_modules
ln -s ~/dsh-mem ~/.dsh/profiles/web/node_modules/dsh-mem
cd ~/dsh-mem && npm install && npm run build
```

Windows 用 NTFS junction（不需要管理员权限）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-mem" `
  -Target "C:\path\to\dsh-mem"
```

再把 `dsh-mem` 加进 profile `package.json` 的 `dsh.profile.bundles`，重启后
`dsh --profile web --dump-config` 应该能看到 `# == dsh-mem` 那一层。

### 卸载

```sh
dsh plugin --profile web remove dsh-mem
```

记忆数据不会被删（它在 `~/.dsh/.dsh-mem/`，独立于安装位置），要清得自己删目录。

## 还没做

dream 的**每晚定时路径**尚未接线，所以现在的自动整理要手动触发（`mem_dream` 或右键菜单）；
40 轮窗口铁律、三层晋升与冲突规则、递归压缩、锚点重访、检索测评集也都还没做。

## 致谢

思路来自对 [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)（MIT）的阅读，
参考了它的客户端插件骨架、dream 调度骨架、BM25 打分器规格，以及它 CHANGELOG 里一批真机
事故的防御性修复。

没抄的部分是自己的设计：提示词全部自写；它用七层 SQLite 当事实源，这里用 markdown vault；
检索走"vault 文档 + 实体名精确命中"，不上向量（实测 BM25 与向量融合无增益）。工具名刻意
错开（它 `memory_*`，这里 `mem_*`），两个记忆插件可以同时装而不撞名。

## 许可

[MIT](LICENSE)
