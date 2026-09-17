# 聊天记忆空间

这个空间记录**关于你**的东西，与你在哪个文件夹聊天无关 ——
换个工作区聊天，读到的是同一份。

## 结构

| 位置 | 作用 |
| --- | --- |
| `README.md` | 本文件。合成后的主上下文入口 |
| `index.md` | 自动生成：sections 与 entities 索引 |
| `sections/` | 分区正文，定义见 `sections.yaml` |
| `entities/` | 人、关系、兴趣、概念、事件各一页 |
| `observations.md` | **暂存区**：信号还不够强，等后续 dream 确证后才晋升 |
| `log.md` | dream 审计日志 |
| `raw/` | 原始素材，未加工 |

## 三层置信度

```
raw/  →  observations.md  →  sections/ + entities/
原始      暂存（不进 README）    确证（进 README，参与常驻注入）
```

**`observations.md` 里的内容不会被主动注入**，只在检索命中时被读到。
这条是为了防止"一次性的随口一提"污染长期画像。

## 引用

确证区里的每条断言都带角标引用，指回它的来源轮次，方便溯源。

---

*这个文件会被 dream 重写；手工修改前请留意。*
