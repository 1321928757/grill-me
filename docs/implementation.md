# grill-me 实现说明

> 本文描述 dsh-grill-me 插件自身如何实现，供维护与二次开发使用；它不是通用 DSH 插件教程。

## 项目定位

本项目只实现 grill-me：用户通过 `/grill-me` 命令（唯一入口）触发拷打后，agent 用设计树 frontier 轮次拷打用户，直到边界明确并固化，才继续执行。插件为 host-only，不含浏览器 client 面。

## 代码布局

```
src/
├── index.ts          # 插件入口：name / inject / Config / apply（协议段 + 装配）
├── command.ts        # /grill-me 宿主命令注册（ctx.commands 子装配 + steer 转发）
├── tools.ts          # 7 个 grill_* 工具的 defineTool 注册 + user-questions 类型桥 + grill_ask 卡片流
├── state.ts          # 设计树纯规则 + session.json 持久化 + 会话锁
├── types.ts          # GrillDecision / GrillSession / GrillStatus
├── event-types.ts    # SessionEventMap 合并（零 import）
└── events.ts         # grill-me/* 事件发射（边界转换 + 降级）
scripts/
├── verify.mjs            # 打包契约 + 纯规则 + 落盘/归档
├── lifecycle-verify.mjs  # 工具生命周期 + 卡片流 + 事件断言 + /grill-me 命令验证
└── stress-verify.mjs     # 并发与隔离矩阵 + grill_ask 边界
```

## 插件契约

- `name`：`grill-me`；`inject`：`tools`、`systemPrompt`、`userQuestions`（`userQuestions` 由 DSH base bundle 组合，`grill_ask` 经它渲染问题卡片）。
- 命令通过 `ctx.inject(['commands'], ...)` 可选子装配注册，不进入顶层 `inject`：`commands` 服务存在时挂载 `/grill-me`，不存在（无命令注册表的组合）时插件照常加载，headless 由协议兜底。
- `Config`：
  - `stateDir`（默认 `.grill-me`）：工作区下的状态目录名；
  - `promptSectionOrder`（默认 `118`）：system prompt 段顺序。
- `cordis.patch.yml` 的 `name` 必须等于 npm 包名 `@nanmicoder/dsh-grill-me`，否则 profile 加载失败。

## 提问呈现（grill_ask 卡片流）

- **目标**：frontier 每轮与 settle 确认强制走 DSH Web GUI 结构化问题卡片（框框），废除纯文本提问。
- **机制**：`grill_ask` 是 grill-me 自持的包装工具，内部直接调用 `ctx.userQuestions.ask()`——卡片按能力接缝渲染（与 preset 组合的 `ask_user_question` 同款 UI），不依赖 preset 是否组合 `tool-ask-user`。
- **类型桥**：`tools.ts` 用本地 `declare module '@deepseek-ai/cordis'` 合并 `Context.userQuestions` 的最小结构契约（`ask(request): Promise<AskUserQuestionAnswer>`），插件不引入 `@deepseek-ai/dsh-user-questions` 依赖；运行时服务对象由宿主提供。
- **frontier 轮**：`grill_ask(session_id)` 读取会话 frontier，每题渲染一张卡片（id=决策 id，header=决策 id，推荐答案为首个选项并附 `(Recommended)` 后缀——卡片 UI 据此显示「推荐」徽标；另有自定义输入与跳过）。返回答案后逐题 `answerDecision` 自动写树：`custom` 优先，否则取 `selected[0]` 并剥离推荐后缀；跳过（`selected: []` 且无 custom）保持决策开放。
- **settle 确认**：frontier 为空且带 `boundary` 时渲染单题确认卡片（`detail` 承载边界规格全文，选项「确认，按此边界执行 (Recommended)」/「需要修改」）；批准即 `settleSession` 并返回 `status: settled` + `boundary`，拒绝返回 `modification`（用户修改意见）保持 open。
- **兜底**：`ctx.userQuestions` 缺失或 provider 未注册（`NO_PROVIDER`）时，工具抛 `grill_ask unavailable: ... (user-questions-unavailable)` 结构化错误；协议要求模型回退纯文本提问，答案经 `grill_answer` / `grill_settle` 记录。
- **护栏**：非 open 会话（settled/archived）在渲染任何卡片前即拒绝。

## /grill-me 命令

- 命令名 `grill-me`（`GRILL_COMMAND`），描述 "Force the grill-me workflow on a query"，输入提示 `[query]`。
- handler 不自己跑设计树：把用户输入的命令原文（`/grill-me` + `rawInput`，含分隔空白）经 `agent.steer(createUserMessage(...))` 作为 user message 交回模型，由模型按 "grill-me:usage" 协议段走 `grill_*` 工具。
- 裸命令（`rawInput` 为空）steer 纯 `/grill-me` 行：协议段规定模型拷打对话中最近一条实质请求。
- 命令原文进会话日志（`command/run` 记录参数、steered user message 保留字面行），重放可完整重建；headless 直接输入同一行时行为一致。
- 模型可见内容必须能由会话日志重建：因此 steer 的是字面命令行而非改写后的提示词。

## 设计树模型

- 决策：`id / question / recommendation / prerequisites / answer / answeredAt`。
- frontier：前置均已答、自身未答的决策集合；每轮只问 frontier。
- 状态机：`open → settled → archived`。
  - settle 要求 frontier 为空且 boundary 非空；
  - archive 后会话冻结，不允许再添加问题或回答。

## 工具行为

| 工具 | 语义 | 失败语义 |
| --- | --- | --- |
| `grill_begin` | query 折叠为 session id，创建 open 会话 | 同名 query 已存在时拒绝 |
| `grill_question` | 添加决策；前置必须已存在且已答 | 未知/未决前置列出 blockers 拒绝 |
| `grill_ask` | frontier 渲染为卡片并自动写回答案；frontier 空 + `boundary` 时渲染 settle 确认卡片（批准即固化） | 未知/非 open 会话拒绝；无 UI provider 抛 `user-questions-unavailable` |
| `grill_answer` | 记录答案并冻结决策 | 已答决策重复回答拒绝 |
| `grill_frontier` | 返回树、frontier、settled、boundary（仅 settle 后出现） | 未知会话拒绝 |
| `grill_settle` | frontier 空且 boundary 非空时固化 | 未满足条件拒绝 |
| `grill_archive` | 归档目录，历史完整保留 | 已归档会话重复归档拒绝 |

## 持久化

- 状态真相源：`<workspace>/<stateDir>/<sessionId>/session.json`。
- 新建：`flag: 'wx'` no-clobber；更新：同目录临时文件 + rename 原子发布。
- 归档：rename 到 `<stateRoot>/archive/`，live 扫描不可见。
- 同一会话的读-改-写由进程内 promise 链锁串行化；多进程不协调。

## 事件

- `grill-me/session-created`、`decision-answered`、`frontier-asked`（含本次答案与 remaining）、`session-settled`、`session-archived`。
- `event-types.ts` 只做 `declare module` 合并，零运行时 import。
- 发射时 `session.append` 是泛型方法，跨边界做受控类型转换；事件 append 失败只降级警告，磁盘状态不受影响。

## 验证

- `pnpm verify` 聚合四段：
  - `verify.mjs`：打包契约、frontier 纯规则、session.json 往返/归档；
  - `lifecycle-verify.mjs`：驱动编译后工具走 begin → question → answer → settle → archive，断言会话事件；`grill_ask` 卡片流（推荐后缀剥离、自定义答案、settle 确认/拒绝/跳过、无 provider、无服务）；验证 `/grill-me` 命令在 commands 服务存在时注册、steer 载荷为字面命令行、裸命令行为、无 steer 通道报错、dispose 清理、无 commands 服务时不注册；
  - `stress-verify.mjs`：重复 begin、未知会话、跨会话隔离、并发回答、迟到写入、重复 archive、grill_ask 未知会话/空 frontier/无 provider；
  - `verify:skill`：`.dsh/skills` 镜像与源一致。
- 组合：`dsh plugin --profile headless add .` + `dsh --profile headless --dump-config | grep "id: grill-me"`。
- 真实 e2e：需要 DSH CLI + `DEEPSEEK_API_KEY`，由 `scripts/e2e.ps1` 或 `Real E2E` 工作流执行；headless 下 `grill_ask` 走文本回退。

## 已知约定

- 一个 query 对应一个会话（id = sanitizeKey(query)），同名 query 需先归档。
- 不记录轮次计数器：轮次是模型按协议驱动的行为，工具只维护设计树状态。
- 磁盘状态是执行真相；会话事件用于审计/重放，两者职责分离。