# grill-me 实现说明

> 本文描述 dsh-grill-me 插件自身如何实现，供维护与二次开发使用；它不是通用 DSH 插件教程。

## 项目定位

本项目实现两个命令：`/grill-me`（纯拷打）与 `/grill-with-docs`（同一强制拷打流程 + domain-modeling 文档沉淀）。用户触发后，agent 用设计树 frontier 轮次拷打用户，直到边界明确并固化，才继续执行。插件为 host-only，不含浏览器 client 面。

## 代码布局

```
src/
├── index.ts          # 插件入口：name / inject / Config / apply（协议段 + 装配）
├── command.ts        # /grill-me 与 /grill-with-docs 宿主命令注册（ctx.commands 子装配 + steer 转发）
├── tools.ts          # 7 个 grill_* 工具的 defineTool 注册 + user-questions 类型桥 + grill_ask 卡片流
├── docs.ts           # grill_docs 工具族（read/update）+ domain-modeling 纯规则（ADR 编号/CONTEXT-FORMAT/多上下文）
├── state.ts          # 设计树纯规则 + session.json 持久化 + 会话锁
├── types.ts          # GrillDecision / GrillSession / GrillStatus
├── event-types.ts    # PluginRecordMap 合并（仅类型；记录名 plugin:grill-me/*）
└── events.ts         # plugin:grill-me/* 记录发射（appendPluginRecord + 降级）
scripts/
├── verify.mjs            # 打包契约 + 纯规则（含 grill-with-docs 规则）+ 落盘/归档
├── lifecycle-verify.mjs  # 工具生命周期 + 卡片流 + grill_docs 工具 + 事件断言 + 命令验证
└── stress-verify.mjs     # 并发与隔离矩阵 + grill_ask/grill_docs 边界
```

## 插件契约

- `name`：`grill-me`；`inject`：`tools`、`systemPrompt`、`userQuestions`（`userQuestions` 由 DSH base bundle 组合，`grill_ask` 经它渲染问题卡片）。
- 命令通过 `ctx.inject(['commands'], ...)` 可选子装配注册，不进入顶层 `inject`：`commands` 服务存在时挂载 `/grill-me`，不存在（无命令注册表的组合）时插件照常加载，headless 由协议兜底。
- `Config`：
  - `stateDir`（默认 `.grill-me`）：工作区下的状态目录名；
  - `promptSectionOrder`（默认 `118`）：system prompt 段顺序；
  - `docsEnabled`（默认 `true`）：`/grill-with-docs` 是否允许写文档；`/grill-me` 始终不写；
  - `docsDir`（默认 `''`）：文档根相对工作区，`''` = 工作区根；
  - `optionCount`（默认 `3`，最小 `3`，无上限）：每题问题卡片至少携带的选项数，`normalizeOptions` 以下限校验。
- `cordis.patch.yml` 的 `name` 必须等于 npm 包名 `@nanmicoder/dsh-grill-me`，否则 profile 加载失败。

## 提问呈现（grill_ask 卡片流）

- **目标**：frontier 每轮强制走 DSH Web GUI 结构化问题卡片（框框），废除纯文本 frontier 提问；settle 确认走纯文本（不渲染卡片）。
- **机制**：`grill_ask` 是 grill-me 自持的包装工具，内部直接调用 `ctx.userQuestions.ask()`——卡片按能力接缝渲染（与 preset 组合的 `ask_user_question` 同款 UI），不依赖 preset 是否组合 `tool-ask-user`。
- **类型桥**：`tools.ts` 用本地 `declare module '@deepseek-ai/cordis'` 合并 `Context.userQuestions` 的最小结构契约（`ask(request): Promise<AskUserQuestionAnswer>`），插件不引入 `@deepseek-ai/dsh-user-questions` 依赖；运行时服务对象由宿主提供。
- **frontier 轮**：`grill_ask(session_id)` 读取会话 frontier，每题渲染一张卡片（id=决策 id，header=决策 id）。决策带 `options`（至少 `optionCount` 个，由 `grill_question` 传入，无上限）时渲染全部选项，首个选项附 `(Recommended)` 后缀——卡片 UI 据此显示「推荐」徽标；不带 `options` 时退回单选卡片（仅推荐答案 + 自定义输入 + 跳过）。返回答案后逐题 `answerDecision` 自动写树：`custom` 优先，否则取 `selected[0]` 并剥离推荐后缀；跳过（`selected: []` 且无 custom）保持决策开放。
- **settle 确认（文本流）**：frontier 为空且带 `boundary` 时**不再调用 `userQuestions.ask()`**，直接返回边界文本（`status` 保持 open、`answers` 空、含 `boundary` 字段），由 agent 用纯文本向用户提问确认；用户批准后调用 `grill_settle` 固化边界（`settleSession` 置 `status: settled`）。不再有「确认/需要修改」卡片交互。
- **兜底**：`ctx.userQuestions` 缺失或 provider 未注册（`NO_PROVIDER`）时，frontier 轮工具抛 `grill_ask unavailable: ... (user-questions-unavailable)` 结构化错误；协议要求模型回退纯文本提问，答案经 `grill_answer` / `grill_settle` 记录。
- **护栏**：非 open 会话（settled/archived）在渲染任何卡片前即拒绝。

## /grill-me 与 /grill-with-docs 命令

- 命令名 `grill-me`（`GRILL_COMMAND`）/ `grill-with-docs`（`GRILL_DOCS_COMMAND`），共用 `registerGrillCommandSpec` 装配：描述不同、steer 的字面行不同（`/grill-me` vs `/grill-with-docs`），成功文案不同。
- handler 不自己跑设计树：把用户输入的命令原文（命令名 + `rawInput`，含分隔空白）经 `agent.steer(createUserMessage(...))` 作为 user message 交回模型，由模型按 "grill-me:usage"（+ "/grill-with-docs" 时 "grill-me:docs-usage"）协议段走 `grill_*` 工具。
- 裸命令（`rawInput` 为空）steer 纯命令行：协议段规定模型拷打对话中最近一条实质请求。
- 命令原文进会话日志（`command/run` 记录参数、steered user message 保留字面行），重放可完整重建；headless 直接输入同一行时行为一致。
- 模型可见内容必须能由会话日志重建：因此 steer 的是字面命令行而非改写后的提示词。

## grill-with-docs 文档能力（docs.ts）

- **纯规则**（`verify.mjs` 覆盖）：`adrSlug`（标题折叠为文件名段，空标题回退 `decision`）、`nextAdrNumber`（扫描最高 `NNNN-` 前缀 +1，跳过非 ADR 文件）、`adrFileName`（`000N-slug.md`）、`renderAdr`（1-3 句正文 + 可选 status frontmatter / considered / consequences）、`detectLayout`（CONTEXT-MAP.md 存在 → multi，否则 single）、`renderContext` / `groupTerms`（CONTEXT-FORMAT：标题 + 描述 + `## Language` + 可选 `###` 分组 + `_Avoid_`）、`upsertTerm`（更新既有术语定义、向既有 `## Language` 追加、缺失时补建 `## Language` 节）。
- **工具**：
  - `grill_docs_read(session_id, scope?)`：读文档根下的 CONTEXT.md / CONTEXT-MAP.md / docs/adr/ 与下一个 ADR 编号；scope ∈ `context | adr | map | all`；返回 lossless JSON（缺失文件不返回对应键）。
  - `grill_docs_update(...)`：kind=term 写 CONTEXT.md（惰性建文件、同术语覆盖、`context` 参数定位多上下文子路径）；kind=adr 写 `docs/adr/000N-*.md`（编号自动递增）；需要 open 会话且 `docsEnabled`；每次写入发射 `plugin:grill-me/docs-updated` 事件（kind/path/scope）。
- **文档根**：`join(workspace, docsDir)`，默认工作区根；`context` 参数在文档根下追加子路径（如 `src/ordering`）。

## 设计树模型

- 决策：`id / question / recommendation / prerequisites / options / answer / answeredAt`（`options` 为可选备选列表，至少 `optionCount` 个（默认 3）、无上限，首个必须是推荐答案，由 `normalizeOptions` 归一校验：≥ optionCount、非空、首项 === recommendation；不传时决策仍为单选语义）。
- frontier：前置均已答、自身未答的决策集合；每轮只问 frontier。
- 状态机：`open → settled → archived`。
  - settle 要求 frontier 为空且 boundary 非空；
  - archive 后会话冻结，不允许再添加问题或回答。

## 工具行为

| 工具 | 语义 | 失败语义 |
| --- | --- | --- |
| `grill_begin` | query 折叠为 session id，创建 open 会话 | 同名 query 已存在时拒绝 |
| `grill_question` | 添加决策；前置必须已存在且已答；可带至少 `optionCount` 个 `options`（首个必须是推荐答案） | 未知/未决前置列出 blockers 拒绝；`options` 数量（< optionCount）或首项不合规拒绝 |
| `grill_ask` | frontier 渲染为卡片并自动写回答案；frontier 空 + `boundary` 时返回边界文本（不渲染卡片），由 `grill_settle` 固化 | 未知/非 open 会话拒绝；frontier 轮无 UI provider 抛 `user-questions-unavailable` |
| `grill_answer` | 记录答案并冻结决策 | 已答决策重复回答拒绝 |
| `grill_frontier` | 返回树、frontier、settled、boundary（仅 settle 后出现） | 未知会话拒绝 |
| `grill_settle` | frontier 空且 boundary 非空时固化 | 未满足条件拒绝 |
| `grill_archive` | 归档目录，历史完整保留 | 已归档会话重复归档拒绝 |
| `grill_docs_read` | 读 CONTEXT.md / CONTEXT-MAP.md / docs/adr/ 现状与下一个 ADR 编号 | 未知会话拒绝 |
| `grill_docs_update` | 写术语（CONTEXT.md）或 ADR（docs/adr/000N-slug.md） | 未知/非 open 会话拒绝；`docsEnabled: false` 拒绝；缺 term+definition 或 title+body 拒绝；未知 kind 拒绝 |

## 持久化

- 状态真相源：`<workspace>/<stateDir>/<sessionId>/session.json`。
- 新建：`flag: 'wx'` no-clobber；更新：同目录临时文件 + rename 原子发布。
- 归档：rename 到 `<stateRoot>/archive/`，live 扫描不可见。
- 同一会话的读-改-写由进程内 promise 链锁串行化；多进程不协调。

## 事件

- 记录名遵循 DSH 0.2 的外部记录语法 `plugin:<owner>/<record>`，六条：`plugin:grill-me/session-created`、`plugin:grill-me/decision-answered`、`plugin:grill-me/frontier-asked`（含本次答案与 remaining）、`plugin:grill-me/session-settled`、`plugin:grill-me/session-archived`、`plugin:grill-me/docs-updated`（grill_docs_update 写入时发射，含 kind/path/scope）。
- `event-types.ts` 用 `declare module '@deepseek-ai/dsh-session/types'` 合并 `PluginRecordMap`（不再是 `SessionEventMap`），零运行时 import；`GrillEventMap` 同时是记录名与 payload 的单一来源。
- 发射走 `appendPluginRecord(session, type, data)`：它只在类型声明于 `PluginRecordMap` 时可用，落盘时自动带 `ignorable: true`，所以不认识该记录的宿主构建会保留并跳过，不会污染 `SessionEventMap` 与已发布的持久化 schema。
- `events.ts` 通过命名空间 import 读取 `Session` 与 `appendPluginRecord` 并做特性检测：缺失 `appendPluginRecord` 的旧宿主不会在模块链接期炸掉整个插件。真实 `Session` 实例走 `appendPluginRecord`，离线 verify 桩件、其它宿主或无该 API 时降级到 `session.append`。任何发射失败都只吞掉，磁盘状态不受影响。

## 验证

- `pnpm verify` 聚合四段：
  - `verify.mjs`：打包契约、frontier 纯规则（含 `normalizeOptions` 的 ≥ optionCount/非空/首项校验，无上限）、grill-with-docs 纯规则（`adrSlug`/`nextAdrNumber`/`adrFileName`/`renderAdr`/`detectLayout`/`renderContext`/`groupTerms`/`upsertTerm`）、session.json 往返/归档；
  - `lifecycle-verify.mjs`：驱动编译后工具走 begin → question → answer → settle → archive，断言会话事件；`grill_ask` 卡片流（多选项卡片渲染、推荐后缀剥离、自定义答案、settle 文本流（返回边界文本不渲染卡片、`grill_settle` 固化）、跳过、无 provider、无服务）；grill_docs 工具流（读空工作区、写术语、读术语、写 ADR、编号递增、未知会话/缺字段/未知 kind 拒绝、docs-updated 事件）；验证 `/grill-me` 与 `/grill-with-docs` 命令在 commands 服务存在时注册、steer 载荷为字面命令行、裸命令行为、无 steer 通道报错、dispose 清理、无 commands 服务时不注册；
  - `stress-verify.mjs`：重复 begin、未知会话、跨会话隔离、并发回答、迟到写入、重复 archive、grill_ask 未知会话/空 frontier/多选项 frontier/无 provider、grill_docs 隔离与未知会话；
  - `verify:skill`：`.dsh/skills` 镜像与源一致。
- 组合：`dsh plugin --profile headless add .` + `dsh --profile headless --dump-config | grep "id: grill-me"`。
- 真实 e2e：需要 DSH CLI + `DEEPSEEK_API_KEY`，由 `scripts/e2e.ps1` 或 `Real E2E` 工作流执行；headless 下 `grill_ask` 走文本回退；`/grill-with-docs` 任务额外核对 CONTEXT.md 与 docs/adr/ 落盘。

## 已知约定

- 一个 query 对应一个会话（id = sanitizeKey(query)），同名 query 需先归档。
- 不记录轮次计数器：轮次是模型按协议驱动的行为，工具只维护设计树状态。
- 磁盘状态是执行真相；会话事件用于审计/重放，两者职责分离。