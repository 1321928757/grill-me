# dsh-grill-me

一句话，让模糊 query 先过拷打，再动手。

`dsh-grill-me` 是 DeepSeek Harness 插件：用户输入 `/grill-me`（唯一入口，无自动触发）后，agent 把需求建成设计树，每轮通过 `grill_ask` 把 frontier 问题以 DSH 问题卡片（框框）形式一次问完并给出推荐答案，直到用户确认边界规格后才会继续执行。

## 为什么需要 grill-me？

| 能力 | 带来的变化 |
| --- | --- |
| 设计树 | 每个决策是节点，答案解锁后续决策，不留隐藏假设 |
| 问题卡片（框框） | 每轮 frontier 与 settle 确认强制以 DSH Web GUI 结构化问题卡片呈现，废除纯文本提问 |
| frontier 轮次 | 每轮只问前置已决的问题，一次问完，推荐答案带「推荐」徽标 |
| 事实自主查询 | agent 自己查环境事实，不反问用户可查的信息 |
| 边界规格 | frontier 清空且用户确认后输出显式 boundary，之后才执行 |
| 持久化与审计 | 设计树落盘 `.grill-me/`，归档保留完整历史，会话事件可重放 |

## 工作原理

`dsh-grill-me` 复用 DSH 的能力接缝（capability seam），不依赖 workflow 引擎：

| DSH 能力 | grill-me 用法 |
| --- | --- |
| `ctx.tools` 注册表 | 注册 7 个 `grill_*` 工具 |
| `ctx.userQuestions` | `grill_ask` 经它渲染 Web GUI 问题卡片并把答案自动写回设计树 |
| `ctx.systemPrompt.section()` | 注册 "grill-me:usage" 协议段（强制卡片提问） |
| `ctx.commands` 注册表 | 注册 `/grill-me` 宿主命令（GUI "/" 菜单可见、客户端拦截） |
| 文件系统 | 状态持久化在 `<workspace>/.grill-me/<sessionId>/session.json` |

数据链路：工具执行 → 磁盘状态（真相源）→ 会话日志事件（审计/重放）。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `grill_begin` | 为一个 query 建立设计树会话，调用者成为持问者 |
| `grill_question` | 添加一个决策；前置已决后进入 frontier |
| `grill_ask` | 把整轮 frontier 渲染为问题卡片并自动记录答案；frontier 为空时渲染 settle 确认卡片（批准即固化边界） |
| `grill_answer` | 记录用户答案，冻结该决策并展开 frontier（文本兜底轮次用） |
| `grill_frontier` | 查看当前树、frontier、已决决策与边界状态 |
| `grill_settle` | frontier 为空且用户确认后，固化边界规格（文本兜底路径） |
| `grill_archive` | 结束并归档会话，完整设计树保留 |

## 安装

> 使用前请确保已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

```sh
dsh plugin --profile web add @nanmicoder/dsh-grill-me
```

从源码构建：

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

## 配置

默认配置可直接使用：

```yaml
- id: grill-me
  config:
    stateDir: .grill-me
```

`stateDir` 是工作区下的状态目录名，默认 `.grill-me`。

## 命令

`/grill-me` 是拷打的唯一入口，模糊 query 不会自动进入设计树。

| 用法 | 语义 |
| --- | --- |
| `/grill-me <query>` | 强制拷打该 query（即使看起来清晰，也必须走完整设计树流程） |
| `/grill-me`（裸命令） | 强制拷打对话中最近一条用户请求 |

GUI 下命令被客户端拦截并出现在 "/" 菜单；headless/CLI 下未经拦截的 `/grill-me` 行由同一份协议兜底，行为一致。

## 使用协议

1. 用户输入 `/grill-me [query]` 后，agent 强制调用 `grill_begin` 建立设计树；不得因 query 清晰而跳过。
2. 每轮调用 `grill_ask` 把整轮 frontier 渲染为 DSH 问题卡片（每题 id 即决策 id、推荐答案为首个选项并带「推荐」徽标、支持自定义输入与跳过）；问题卡片是唯一允许的提问形式，禁止纯文本提问。
3. `grill_ask` 自动把答案写入设计树并返回新 frontier；不提前问依赖未决的问题。
4. 需要查证的事实由 agent 自己完成，只有决策属于用户。
5. frontier 为空时，agent 写出显式边界规格并再次调用 `grill_ask`（带 `boundary`）渲染 settle 确认卡片；用户批准后边界才固化，之前不得执行 query。
6. 执行完成后调用 `grill_archive` 归档完整设计树。
7. 无问题卡片 UI 的环境（headless CLI）下 `grill_ask` 返回 `user-questions-unavailable` 错误，此时回退纯文本提问，答案经 `grill_answer` / `grill_settle` 记录。

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