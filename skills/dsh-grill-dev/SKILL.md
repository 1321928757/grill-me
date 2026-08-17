---
name: dsh-grill-dev
description: 开发、维护和验证 grill-me DSH 插件的执行型 Skill。覆盖设计树状态、grill_* 工具、system prompt 协议、离线 verify 与真实 DSH 组合验证。人类只审查，agent 拥有全部文件编辑权。
metadata:
  version: "0.1.0"
  date: "2026-08-17"
  reference: "https://github.com/shironghe/grill-me"
---

# grill-me 插件开发

先读根目录 `AGENTS.md`，再按本 Skill 开发。人类只负责审查，agent 负责全部代码与文档变更。

## 1. 协议事实

- 模糊 query 进入设计树；每个决策是节点，答案解锁后续决策。
- 每轮只问 frontier（前置已决的决策），一次问完，每题带推荐答案。
- 事实由 agent 查询，不由用户提供；只有决策属于用户。
- frontier 为空且用户确认后才 `grill_settle`，随后 agent 才执行 query。

## 2. 实现约束

- 状态真相源是 `<workspace>/.grill-me/<sessionId>/session.json`；工具执行必须串行化同一会话的读改写。
- 新决策必须校验前置已存在且已答；已答决策不可再答。
- settle 要求 frontier 为空且 boundary 非空；archive 保留完整设计树。
- `grill_*` 工具的 description 就是模型契约，写清前置条件和失败语义。
- 工具返回值必须是 lossless JSON：任何键都不得为 `undefined`（DSH 的 `snapshotJsonValue` 会把含 `undefined` 的值判为非法输出）。未 settle 的会话不要返回 `boundary` 键。

## 3. 验证

```sh
pnpm typecheck
pnpm build
pnpm verify
```

- 纯规则：frontier 计算、前置门禁、冻结语义、settle/archive 迁移。
- 落盘：临时目录 session.json 往返、原子更新、归档移动。
- 工具输出保真：lifecycle/stress verify 用 `snapshotJsonValue` + `validateJsonSchemaValue` 复刻 DSH 的工具输出校验，任何工具返回非 lossless JSON 或违反输出 schema 都会使 verify 失败。
- 真实组合：`dsh plugin --profile headless add .` 后跑一个真实 LLM 拷打任务，核对 `.grill-me/` 落盘。
- 开 PR 前按 grilling 协议自审：有没有替用户假设答案、有没有跳过 frontier。