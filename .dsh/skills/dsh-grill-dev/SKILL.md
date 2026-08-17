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

grill-me 插件含两个命令：`/grill-me`（纯拷打）与 `/grill-with-docs`（拷打 + domain-modeling 文档沉淀，能力提取自 `~/.codex/skills/mattskills/` 的 grill-with-docs 技能，设计说明见 `docs/grill-with-docs.md`）。

## 1. 协议事实

- 模糊 query 进入设计树；每个决策是节点，答案解锁后续决策。
- 每轮只问 frontier（前置已决的决策），一次问完，推荐答案带「推荐」徽标。
- **frontier 提问强制走卡片**：每轮 frontier 经 `grill_ask` 用 DSH Web GUI 结构化问题卡片呈现（`ctx.userQuestions.ask()` 渲染，与 `ask_user_question` 同款），禁止纯文本提问；无 UI provider 时 `grill_ask` 报 `user-questions-unavailable`，才回退纯文本（答案经 `grill_answer` 记录）。
- **settle 确认走文本**：frontier 为空时 `grill_ask` 带 `boundary` 返回边界文本（不渲染确认卡片），agent 用纯文本提问确认，用户批准后调用 `grill_settle` 固化边界。
- 事实由 agent 查询，不由用户提供；只有决策属于用户。

## 2. 实现约束

- 状态真相源是 `<workspace>/.grill-me/<sessionId>/session.json`；工具执行必须串行化同一会话的读改写。
- 新决策必须校验前置已存在且已答；已答决策不可再答。
- settle 要求 frontier 为空且 boundary 非空；archive 保留完整设计树。
- `grill_*` 工具的 description 就是模型契约，写清前置条件和失败语义。
- `grill_question` 支持每题至少 `optionCount` 个备选选项（`options` 字段，配置默认 3、无上限），推荐答案必须是首个选项（校验：≥ optionCount 个、非空、首项 === recommendation）；不传 `options` 时退回单选卡片。
- `grill_ask` 的卡片契约：每题 id=决策 id；有 `options` 时渲染全部选项、首个附 `(Recommended)` 后缀（卡片据此渲染「推荐」徽标），无 `options` 时渲染单选项卡片；答案写树时 `custom` 优先、`selected[0]` 剥离推荐后缀、跳过保持开放。
- 工具返回值必须是 lossless JSON：任何键都不得为 `undefined`（DSH 的 `snapshotJsonValue` 会把含 `undefined` 的值判为非法输出）。未 settle 的会话不要返回 `boundary` 键；settle 走文本确认（`grill_ask` 带 boundary 返回 `boundary` 且 status 保持 open，由 `grill_settle` 固化）。
- `/grill-with-docs` 的文档工具族（`src/docs.ts`）：
  - `grill_docs_read`：读 CONTEXT.md / CONTEXT-MAP.md / docs/adr/ 现状与下一个 ADR 编号，避免重复与猜测。
  - `grill_docs_update`：kind=term 写 CONTEXT.md 术语（CONTEXT-FORMAT：opinionated、`_Avoid_`、紧凑定义、惰性建文件）；kind=adr 写 `docs/adr/000N-slug.md`（编号扫描最高 +1、三条件才提供）。
  - 磁盘为真相源；每次写入发射 `grill-me/docs-updated` 事件；写入需 open 会话且 `docsEnabled` 为 true；文档落点默认工作区根（`docsDir` 可覆盖）。

## 3. 验证

```sh
pnpm typecheck
pnpm build
pnpm verify
```

- 纯规则：frontier 计算、前置门禁、冻结语义、settle/archive 迁移、`options` 归一（≥ optionCount、非空、首项为推荐）、推荐后缀剥离与卡片答案归一；grill-with-docs 的 ADR 编号/格式、CONTEXT-FORMAT 生成与 upsert、多上下文判定。
- 落盘：临时目录 session.json 往返（含多选项决策）、原子更新、归档移动；临时目录 CONTEXT.md / docs/adr/ 写入与读取。
- 工具输出保真：lifecycle/stress verify 用 `snapshotJsonValue` + `validateJsonSchemaValue` 复刻 DSH 的工具输出校验，任何工具返回非 lossless JSON 或违反输出 schema 都会使 verify 失败。
- 卡片流：lifecycle/stress verify 用可换装的 `ctx.userQuestions.ask` 桩驱动 `grill_ask`（多选项 frontier 卡片、单选兜底、settle 文本流（不渲染卡片）、无 provider/无服务回退）。
- 文档流：lifecycle/stress verify 驱动 `grill_docs_read` / `grill_docs_update`（术语写入、ADR 编号递增、未知会话/缺字段拒绝、事件发射、跨会话隔离）。
- 真实组合：`dsh plugin --profile headless add .` 后跑一个真实 LLM 拷打任务，核对 `.grill-me/` 落盘；`/grill-with-docs` 任务额外核对 CONTEXT.md 与 docs/adr/。
- 开 PR 前按 grilling 协议自审：有没有替用户假设答案、有没有跳过 frontier。