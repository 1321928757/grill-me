# dsh-grill-me

[English](./README.md) | **简体中文**

一句话，让模糊 query 先过拷打，再动手。

`dsh-grill-me` 是 DeepSeek Harness 插件：用户输入 `/grill-me`（唯一入口，无自动触发）后，agent 把需求建成设计树，每轮通过 `grill_ask` 把 frontier 问题以 DSH 问题卡片（框框）形式一次问完并给出推荐答案，直到用户确认边界规格后才会继续执行。

## 为什么需要 grill-me？

| 能力 | 带来的变化 |
| --- | --- |
| 设计树 | 每个决策是节点，答案解锁后续决策，不留隐藏假设 |
| 问题卡片（框框） | 每轮 frontier 强制以 DSH Web GUI 结构化问题卡片呈现；settle 确认走纯文本提问（不渲染卡片），废除纯文本 frontier 提问 |
| frontier 轮次 | 每轮只问前置已决的问题，一次问完，推荐答案带「推荐」徽标 |
| 事实自主查询 | agent 自己查环境事实，不反问用户可查的信息 |
| 边界规格 | frontier 清空且用户确认后输出显式 boundary，之后才执行 |
| 持久化与审计 | 设计树落盘 `.grill-me/`，归档保留完整历史，`plugin:grill-me/*` 记录留在会话日志 |

## 为什么还要这个插件，而不是直接用原版 skill？

`dsh-grill-me` 是移植，不是发明。方法论来自 `mattpocock/skills` 里的 [`grilling`](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md)——那里的 `grill-me` 与 `grill-with-docs` 只是一行「调用 grilling」的包装。设计树、frontier、分轮、事实归 agent 而决策归用户、收尾门禁，全部是原版的想法，没有改动。

变的是「谁来保证它被执行」：

| 原版 skill | 本插件 |
| --- | --- |
| 靠提示词要求走 frontier 轮次；模型想一次一问、想跳过、想自己替用户答题，没有东西拦得住 | `grill_question` 拒绝前置未答的决策，使它无法提前进入 frontier；`grill_settle` 在 frontier 非空时直接报错；已答决策冻结不可改 |
| 问题以编号 Markdown 列表下发，你回一行「1 是、2 第二个选项」 | 问题以 DSH 问题卡片下发：每题至少三个选项、推荐答案居首带「推荐」徽标，另有自定义输入与跳过 |
| 无状态：不写任何文件，会话一关设计树就没了 | 设计树落盘在 `.grill-me/`：能跨上下文压缩存活、能归档、事后可审计 |

这就是取舍：插件拿原版的可移植性，换来了「模型赶时间时依然成立」的约束。

**这些情况请用原版**：你不在 DSH 里（Claude Code、Codex、手机端）、手上没有工作区、话题不是代码（商业判断、写作、下一步做什么），或者问题需要好几段上下文才说得清——文本比选项更挖得动。去 `mattpocock/skills` 装 `grilling` + `grill-me` 即可。

## 工作原理

`dsh-grill-me` 复用 DSH 的能力接缝（capability seam），不依赖 workflow 引擎：

| DSH 能力 | grill-me 用法 |
| --- | --- |
| `ctx.tools` 注册表 | 注册 7 个 `grill_*` 工具 |
| `ctx.userQuestions` | `grill_ask` 经它渲染 Web GUI 问题卡片并把答案自动写回设计树 |
| `ctx.systemPrompt.section()` | 注册 "grill-me:usage" 协议段（强制卡片提问） |
| `ctx.commands` 注册表 | 注册 `/grill-me` 宿主命令（GUI "/" 菜单可见、客户端拦截） |
| 文件系统 | 状态持久化在 `<workspace>/.grill-me/<sessionId>/session.json` |

数据链路：工具执行 → 磁盘状态（真相源）→ 会话日志的 `plugin:grill-me/*` 记录（审计）。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `grill_begin` | 为一个 query 建立设计树会话，调用者成为持问者 |
| `grill_question` | 添加一个决策；前置已决后进入 frontier（可带至少 `optionCount` 个 `options` 渲染多选项卡片） |
| `grill_ask` | 把整轮 frontier 渲染为问题卡片并自动记录答案；frontier 为空且带 `boundary` 时返回边界文本供纯文本确认（不渲染卡片） |
| `grill_answer` | 记录用户答案，冻结该决策并展开 frontier（文本兜底轮次用） |
| `grill_frontier` | 查看当前树、frontier、已决决策与边界状态 |
| `grill_settle` | frontier 为空且用户纯文本确认后，固化边界规格 |
| `grill_archive` | 结束并归档会话，完整设计树保留 |
| `grill_docs_read` | 读当前 CONTEXT.md / CONTEXT-MAP.md / docs/adr/ 现状与下一个 ADR 编号（grill-with-docs） |
| `grill_docs_update` | 把术语或 ADR 落盘（grill-with-docs） |

## 安装

> 需要 DeepSeek Harness **0.2.1-rc.1**（`engines.dsh: ">=0.2.1-rc.1 <0.3.0"`），Node `^22.19.0 || >=24`。
> 本包尚未发布到 npm，且构建产物 `lib/` 不入库——直接按 Git 地址安装会装到一份没编译的包。先本地构建，再添加目录。

```sh
git clone https://github.com/shironghe/grill-me.git
cd grill-me
pnpm install
pnpm build
dsh plugin --profile web add .
```

检查组合配置并重启 DSH：

```sh
dsh --profile web --dump-config
dsh web
```

`--dump-config` 里应出现 `grill-me` 条目。请装进你实际运行的那个 profile（`web`、`desktop` 等）；DSH 重启后，输入框的 `/` 菜单里能看到 `/grill-me`。

## 配置

默认配置可直接使用：

```yaml
- id: grill-me
  config:
    stateDir: .grill-me
    optionCount: 3
```

`stateDir` 是工作区下的状态目录名，默认 `.grill-me`。`optionCount`（默认 `3`，最小 `3`，无上限）是每题问题卡片至少应携带的选项数，agent 每题至少提供该数量的备选。

## 命令

`/grill-me` 是拷打的唯一入口，模糊 query 不会自动进入设计树；`/grill-with-docs` 跑同一强制流程，并在拷打过程中把领域模型沉淀为文档。

| 用法 | 语义 |
| --- | --- |
| `/grill-me <query>` | 强制拷打该 query（即使看起来清晰，也必须走完整设计树流程） |
| `/grill-me`（裸命令） | 强制拷打对话中最近一条用户请求 |
| `/grill-with-docs <query>` | 强制拷打该 query，并在决策结晶时写 CONTEXT.md 术语表与 ADR |
| `/grill-with-docs`（裸命令） | 强制拷打最近一条请求并写文档 |

GUI 下命令被客户端拦截并出现在 "/" 菜单；headless/CLI 下未经拦截的 `/grill-me` 行由同一份协议兜底，行为一致。

## 使用协议

1. 用户输入 `/grill-me [query]` 后，agent 强制调用 `grill_begin` 建立设计树；不得因 query 清晰而跳过。
2. 每轮调用 `grill_ask` 把整轮 frontier 渲染为 DSH 问题卡片（每题 id 即决策 id、每题至少 `optionCount` 个选项且推荐答案居首带「推荐」徽标、支持自定义输入与跳过）；frontier 提问时卡片是唯一允许的提问形式，禁止纯文本提问。
3. `grill_ask` 自动把答案写入设计树并返回新 frontier；不提前问依赖未决的问题。
4. 需要查证的事实由 agent 自己完成，只有决策属于用户。
5. frontier 为空时，agent 写出显式边界规格并再次调用 `grill_ask`（带 `boundary`）——它返回边界文本、不渲染确认卡片；agent 用纯文本向用户提问确认，用户批准后才调用 `grill_settle` 固化边界，之前不得执行 query。
6. 执行完成后调用 `grill_archive` 归档完整设计树。
7. 无问题卡片 UI 的环境（headless CLI）下 `grill_ask` 对 frontier 轮次返回 `user-questions-unavailable` 错误，此时回退纯文本提问，答案经 `grill_answer` / `grill_settle` 记录。

`/grill-with-docs` 额外执行文档协议：拷打过程中用 `grill_docs_read` 查看现有 CONTEXT.md 术语表与 ADR 编号，用 `grill_docs_update` 把结晶的术语（kind=term）或架构决策（kind=adr）落盘到工作区文档根下的 CONTEXT.md 与 `docs/adr/000N-*.md`，遵循 CONTEXT-FORMAT 与 ADR-FORMAT（见 [docs/grill-with-docs.md](./docs/grill-with-docs.md)）。写文档要求会话 open 且 `docsEnabled` 为 true（默认）；`/grill-me` 永不写文档。

## 验证

```sh
pnpm typecheck
pnpm build
pnpm verify
```

验证矩阵覆盖：打包契约、设计树纯规则、工具生命周期、并发/隔离、skill 镜像。真实 e2e 需要 DSH CLI 与 `DEEPSEEK_API_KEY`，详见 [docs/verification-guide.md](./docs/verification-guide.md)。

## 已知限制

- 一个 query 对应一个会话；同名 query 需先归档旧会话。
- 状态为文件级持久化，多进程同时操作同一会话不保证一致（同一 dsh 进程内已串行化）。
- 提问卡片依赖 `ctx.userQuestions` 能力（DSH base bundle 已组合）与 Web GUI 的 UI provider；headless 下自动回退文本（见协议第 7 条）。
- 模型可能不严格走工具仪式（如忘记 settle）；以 `grill_frontier` / 落盘状态为准。
- 私有免费仓库无 GitHub 分支保护；改公开后可启用。

## 文档

| 指南 | 内容 |
| --- | --- |
| [使用指南](./docs/usage.md) | 架构、工具、协议、配置、限制与验证 |
| [验证指南](./docs/verification-guide.md) | 离线、组合、真实 e2e 与验证清单 |
| [实现说明](./docs/implementation.md) | grill-me 自身实现与维护指南 |
| [grill-with-docs](./docs/grill-with-docs.md) | 从原版技能提取的 domain-modeling 文档能力（CONTEXT.md / ADR） |
| [AI 流水线](./docs/ai-pipeline.md) | 人类只审查、agent 只实现的工作流 |

## 开发

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm verify
```

## License

[MIT](./LICENSE)