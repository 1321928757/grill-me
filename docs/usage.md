# 使用指南（详细）

本文档收纳 dsh-grill-me 的详细使用内容：工作原理、工具一览、使用协议、配置、已知限制与验证。README 只保留简介与快速上手。

## 工作原理

`dsh-grill-me` 复用 DSH 的能力接缝（capability seam），不依赖 workflow 引擎：

| DSH 能力 | grill-me 用法 |
| --- | --- |
| `ctx.tools` 注册表 | 注册 7 个 `grill_*` 工具 |
| `ctx.userQuestions` | `grill_ask` 经它渲染 Web GUI 问题卡片并把答案自动写回设计树 |
| `ctx.systemPrompt.section()` | 注册 "grill-me:usage" 协议段，order 默认 118 |
| `ctx.commands` 注册表 | 注册 `/grill-me` 宿主命令（GUI "/" 菜单可见、客户端拦截） |
| 文件系统 | 团队状态持久化在 `<workspace>/.grill-me/<sessionId>/session.json`，归档在 `<workspace>/.grill-me/archive/` |

数据链路：命令/工具执行 → 磁盘状态（真相源）→ 会话日志事件（尽力而为的审计记录）。

### 提问呈现

- **frontier 走问题卡片（框框）**：每轮 frontier 经 `grill_ask` 走 DSH Web GUI 的结构化问题卡片（`ctx.userQuestions.ask()` 渲染，与 `ask_user_question` 同款：标题、编号选项、「推荐」徽标、自定义输入、跳过/提交）。
- **settle 确认走纯文本**：frontier 为空时 `grill_ask` 带 `boundary` 返回边界文本（不渲染确认卡片），agent 用纯文本提问确认，用户批准后调用 `grill_settle` 固化。
- 卡片按能力接缝渲染，不依赖 preset 是否组合 `tool-ask-user`。
- 无 UI provider（headless CLI / 纯终端）时 `grill_ask` 对 frontier 轮抛 `user-questions-unavailable` 结构化错误，模型回退纯文本提问，答案经 `grill_answer` / `grill_settle` 记录。

### 设计树模型

- **决策（decision）**：一个必须由用户明确的问题，含 id、question、recommendation、prerequisites、可选 options（至少 `optionCount` 个备选（默认 3、无上限），首个即推荐答案）、answer、answeredAt。
- **frontier**：前置均已答、自己尚未回答的决策集合；每轮只问 frontier。
- **会话状态机**：`open → settled → archived`；settle 要求 frontier 为空且 boundary 非空，archive 后不可再修改。

### 会话状态文件

```
<workspace>/.grill-me/<sessionId>/
└── session.json        # 设计树、决策、boundary、状态、时间戳
```

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `grill_begin` | 建立会话；query 折叠成 session id；同名 query 已存在时拒绝 |
| `grill_question` | 添加决策；前置必须已存在且已答，否则拒绝并列出未决前置；可传至少 `optionCount` 个 `options`（首个必须是推荐答案，无上限）渲染多选项卡片 |
| `grill_ask` | 把整轮 frontier 渲染为问题卡片（每题至少 `optionCount` 个选项、推荐答案居首带「推荐」徽标，另有自定义输入与跳过），自动把答案写入设计树并返回新 frontier；frontier 为空且带 `boundary` 时返回边界文本（不渲染卡片），由 `grill_settle` 固化 |
| `grill_answer` | 记录答案；已答决策冻结，迟到的重复答案被拒绝（文本兜底轮次用） |
| `grill_frontier` | 返回 status、frontier、settled、boundary（boundary 仅 settle 后出现） |
| `grill_settle` | frontier 为空且 boundary 非空时固化边界规格（文本兜底路径） |
| `grill_archive` | 归档会话目录，完整设计树保留供复盘 |
| `grill_docs_read` | 读当前 CONTEXT.md / CONTEXT-MAP.md / docs/adr/ 现状与下一个 ADR 编号（grill-with-docs） |
| `grill_docs_update` | 把结晶的术语（kind=term，写 CONTEXT.md）或架构决策（kind=adr，写 docs/adr/000N-slug.md）落盘（grill-with-docs） |

工具输出全部符合 DSH `JsonValue` 契约：任何时刻都不含 `undefined`（未 settle 的会话不返回 `boundary` 键，settle 被拒时不返回 `boundary` 而返回 `modification`），同一会话的读-改-写由进程内锁串行化。

## 命令

`/grill-me` 是纯拷打的唯一入口：没有自动触发，模糊 query 不会自行进入设计树。`/grill-with-docs` 跑同一强制流程，并在拷打过程中把领域模型沉淀为文档（能力源自 grill-with-docs 技能，见 [grill-with-docs.md](./grill-with-docs.md)）。

| 用法 | 语义 |
| --- | --- |
| `/grill-me <query>` | 强制拷打该 query（即使看起来清晰，也必须走完整设计树流程） |
| `/grill-me`（裸命令） | 强制拷打对话中最近一条用户请求；没有可拷打的请求时说明并提示用法 |
| `/grill-with-docs <query>` | 强制拷打该 query，并在决策结晶时写 CONTEXT.md 术语表与 ADR |
| `/grill-with-docs`（裸命令） | 强制拷打最近一条请求并写文档 |

- GUI（web profile）：命令被客户端拦截，出现在 "/" 命令菜单，`command/run` 事件记录参数；handler 把命令原文经 `agent.steer()` 交给模型，模型走 `grill_*` 工具流程。
- headless/CLI：未经拦截的 `/grill-me` 文本行由同一份 system prompt 协议兜底，行为与 GUI 一致。

## 使用协议

1. 用户输入 `/grill-me [query]` 后，agent 强制调用 `grill_begin` 建立设计树；不得因 query 清晰而跳过。
2. 每轮调用 `grill_ask` 把整轮 frontier 渲染为问题卡片（每题 id 即决策 id、每题至少 `optionCount` 个选项且推荐答案居首带「推荐」徽标、支持自定义输入与跳过）；frontier 提问时卡片是唯一允许的提问形式，禁止纯文本提问。
3. `grill_ask` 自动把答案写入设计树并返回新 frontier；不提前问依赖未决的问题。
4. 需要查证的事实由 agent 自己完成（文件、工具、环境），只有决策属于用户。
5. frontier 为空时，agent 写出显式边界规格并以 `boundary` 参数再次调用 `grill_ask`：它返回边界文本（不渲染确认卡片），agent 用纯文本向用户提问确认；用户批准后调用 `grill_settle` 固化边界（`status: settled`），之前不得执行 query。
6. 执行完成后调用 `grill_archive` 归档完整设计树。
7. 无问题卡片 UI 的环境（headless CLI / 纯终端 / 未组合 user-questions）下 `grill_ask` 对 frontier 轮返回 `user-questions-unavailable` 结构化错误，回退纯文本提问，答案经 `grill_answer` / `grill_settle` 记录。

### grill-with-docs 文档协议（/grill-with-docs 触发）

1. 拷打流程与 `/grill-me` 完全一致（上述 1-7）。
2. 每轮用 `grill_docs_read` 查看现有 CONTEXT.md 术语表、CONTEXT-MAP.md 与 docs/adr/ 编号，避免重复与猜测。
3. 术语结晶即用 `grill_docs_update`（kind=term）内联更新 CONTEXT.md：一个规范词、一两句"是什么"的定义、可选 `_Avoid_` 列表与分组；不批量。
4. ADR 只在三条件全真时用 `grill_docs_update`（kind=adr）提供：难逆转 / 无上下文会惊讶 / 真实权衡；编号用 `grill_docs_read` 报告的下一个序号。
5. 立即挑战冲突或模糊术语、用具体场景压力测试领域关系、与代码交叉引用，然后用 `grill_docs_update` 固化。
6. 磁盘是真相源：每次 `grill_docs_update` 写 CONTEXT.md 或 `docs/adr/000N-*.md` 并记录 `grill-me/docs-updated` 事件；grill-with-docs 会话内不得用其他工具手改这些文件。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: grill-me
  config:
    stateDir: .grill-me
    docsEnabled: true
    docsDir: ''
    optionCount: 3
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `stateDir` | `.grill-me` | 状态目录名（工作区下） |
| `promptSectionOrder` | `118` | system prompt 段顺序 |
| `docsEnabled` | `true` | `/grill-with-docs` 是否允许写文档；`/grill-me` 始终不写 |
| `docsDir` | `''` | 文档根相对工作区；`''` = 工作区根 |
| `optionCount` | `3` | 每题问题卡片至少携带的选项数（最小 3、无上限） |

## 已知限制

- 一个 query 对应一个会话；同名 query 需先归档旧会话。
- 状态为文件级持久化，多进程同时操作同一会话不保证一致（同一 dsh 进程内已用锁串行化）。
- 提问卡片依赖 `ctx.userQuestions` 能力（DSH base bundle 已组合）与 Web GUI 的 UI provider；headless 下 `grill_ask` 报 `user-questions-unavailable`，协议回退文本（见第 7 条）。
- 模型可能不严格走工具仪式（如忘记 settle 或 update）；面板与协议以 `grill_frontier` / 落盘状态为准。
- 会话事件为尽力而为的审计记录（外部插件事件类型可能被宿主运行时的类型白名单拒绝）；磁盘状态是执行真相源，`tool/call` 事件保留完整调用链。

## 验证

- 离线与生命周期：`pnpm typecheck && pnpm build && pnpm verify`。
  - `verify.mjs`：打包契约、设计树纯规则（含多选项归一）、grill-with-docs 纯规则（ADR 编号/格式、CONTEXT-FORMAT 生成与 upsert、多上下文判定）、session.json 落盘/归档。
  - `lifecycle-verify.mjs`：驱动编译后的 7 个 grill_* 工具走完 begin → question → answer → settle → archive，断言会话事件；覆盖 `grill_ask` 卡片流（多选项卡片、settle 文本流（返回边界文本不渲染卡片、`grill_settle` 固化）、跳过、无 provider/无服务回退）、`grill_docs_read`/`grill_docs_update` 工具流（术语写入、ADR 编号递增、未知会话/缺字段拒绝、事件发射）与 `/grill-me`、`/grill-with-docs` 命令注册、steer 载荷、裸命令与清理。
  - `stress-verify.mjs`：重复 begin、未知会话、跨会话隔离、并发回答、settle 后迟到写入、重复 archive、grill_ask 未知会话/空 frontier/多选项 frontier/无 provider、grill_docs 隔离与未知会话。
  - `verify:skill`：`.dsh/skills` 镜像与源 skill 一致。
- 组合验证：`dsh plugin --profile headless add .` 后 `dsh --profile headless --dump-config | grep "id: grill-me"`。
- 真实 e2e：`dsh --profile headless "/grill-me 用户想做一个'智能体系统'"`，核对 `.grill-me/` 落盘与会话事件（headless 下 `grill_ask` 走文本回退）；`/grill-with-docs` 任务额外核对 CONTEXT.md 与 docs/adr/ 落盘。