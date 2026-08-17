# grill-me 使用指南

## 工作原理

`dsh-grill-me` 复用 DSH 的能力接缝：

| DSH 能力 | grill-me 用法 |
|---|---|
| `ctx.tools` 注册表 | 注册 `grill_begin` / `grill_question` / `grill_answer` / `grill_frontier` / `grill_settle` / `grill_archive` |
| `ctx.systemPrompt.section()` | 注册 "grill-me:usage" 协议段：模糊 query 先拷打，后执行 |
| 文件系统 | 设计树持久化在 `<workspace>/.grill-me/<sessionId>/session.json`，归档保留在 `archive/` |

数据链路：工具执行 → 磁盘状态（真相源）→ 会话日志事件（审计/重放）。

## 协议

1. 用户给出模糊 query 时，agent 建立设计树。
2. 每轮把 frontier 问题一次问完，每题附推荐答案；不提前问依赖未决的问题。
3. 用户回答后冻结决策，frontier 外扩，进入下一轮。
4. frontier 为空且用户确认后，agent 调用 `grill_settle` 固化边界规格。
5. 执行完成后 `grill_archive` 归档完整设计树。

## 配置

```yaml
- id: grill-me
  config:
    stateDir: .grill-me
    maxRounds: 8
```

## 已知限制

- 一个会话对应一个 query 键；同名 query 需要先归档旧会话。
- 状态为文件级持久化，多进程同时操作同一会话不保证一致。
- 模型可能不严格遵守工具仪式；边界规格以 `grill_frontier` / 落盘状态为准。