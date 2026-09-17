# 项目记忆

这是**某一个具体项目**的记忆，位于 `项目记忆/projects/<项目名>/`。

## 结构

| 位置 | 作用 |
| --- | --- |
| `README.md` | 本文件 |
| `meta.yaml` | 这个项目的元信息：key / 路径 / 名字 / 时间 |
| `index.md` | 自动生成：sections 与 entities 索引 |
| `timeline.md` | **项目时间线**，一轮一行摘要 + `[→ id]` 指针 |
| `sections/` | 正文，定义见 `sections.yaml`（目标 / 待办 / 架构 / 决策 / 踩坑） |
| `entities/` | **这个项目内部**的模块、外部依赖、协作者 |
| `observations.md` | 暂存区，未确证 |
| `log.md` | 整理（dream）的审计日志 |
| `raw/` | 原始素材；`raw/timeline/` 存完整改动、`raw/anchors.jsonl` 存来源锚点 |

## 注入规则

**整个项目记忆都不主动注入上下文。** 需要什么让 AI 去取：

- `mem_search` 跨项目检索（结果带归属）
- `mem_entity` 按名字翻实体页
- `mem_diff` 按 `[→ id]` 取某条改动的完整内容

## 时间线的两层

```
timeline.md          摘要：一轮一行，带指针
   │ [→ id]
raw/timeline/        详情（永不注入）：完整改前 / 改后
```

详情由 `tools/result` 钩子自动采集 —— `write`/`edit` 本来就把 diff 附在结果上，
所以这里不需要额外算 diff 或做文件快照。

---

*这个文件会被整理环节重写；手工修改前请留意。*
