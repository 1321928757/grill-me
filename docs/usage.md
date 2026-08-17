# 使用指南（详细）

本文档收纳 dsh-grill-me 的详细使用内容：工作原理、工具一览、使用协议、配置、已知限制与验证。README 只保留简介与快速上手。

## 工作原理

`dsh-grill-me` 复用 DSH 的能力接缝（capability seam），不依赖 workflow 引擎：

| DSH 能力 | grill-me 用法 |
| --- | --- |
| `ctx.tools` 注册表 | 注册 6 个 `grill_*` 工具 |
| `ctx.systemPrompt.section()` | 注册 "grill-me:usage" 协议段，order 默认 118 |
| 文件系统 | 团队状态持久化在 `<workspace>/.grill-me/<sessionId>/session.json`，归档在 `<workspace>/.grill-me/archive/` |

数据链路：工具执行 → 磁盘状态（真相源）→ 会话日志事件（尽力而为的审计记录）。

### 设计树模型

- **决策（decision）**：一个必须由用户明确的问题，含 id、question、recommendation、prerequisites、answer、answeredAt。
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
| `grill_question` | 添加决策；前置必须已存在且已答，否则拒绝并列出未决前置 |
| `grill_answer` | 记录答案；已答决策冻结，迟到的重复答案被拒绝 |
| `grill_frontier` | 返回 status、frontier、settled、boundary |
| `grill_settle` | frontier 为空且 boundary 非空时固化边界规格 |
| `grill_archive` | 归档会话目录，完整设计树保留供复盘 |

工具输出全部符合 DSH `JsonValue` 契约；同一会话的读-改-写由进程内锁串行化。

## 使用协议

1. 用户给出模糊 query 时，agent 调用 `grill_begin` 建立设计树。
2. 每轮把 frontier 问题一次问完，每题附推荐答案；不提前问依赖未决的问题。
3. 用户回答后调用 `grill_answer` 冻结决策，frontier 外扩，进入下一轮。
4. 需要查证的事实由 agent 自己完成（文件、工具、环境），只有决策属于用户。
5. frontier 为空且用户确认后，调用 `grill_settle` 固化边界规格。
6. 执行完成后调用 `grill_archive` 归档完整设计树。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: grill-me
  config:
    stateDir: .grill-me
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `stateDir` | `.grill-me` | 状态目录名（工作区下） |
| `promptSectionOrder` | `118` | system prompt 段顺序 |

## 已知限制

- 一个 query 对应一个会话；同名 query 需先归档旧会话。
- 状态为文件级持久化，多进程同时操作同一会话不保证一致（同一 dsh 进程内已用锁串行化）。
- 模型可能不严格走工具仪式（如忘记 settle 或 update）；面板与协议以 `grill_frontier` / 落盘状态为准。
- 会话事件为尽力而为的审计记录（外部插件事件类型可能被宿主运行时的类型白名单拒绝）；磁盘状态是执行真相源，`tool/call` 事件保留完整调用链。

## 验证

- 离线与生命周期：`pnpm typecheck && pnpm build && pnpm verify`。
  - `verify.mjs`：打包契约、设计树纯规则、session.json 落盘/归档。
  - `lifecycle-verify.mjs`：驱动编译后的 6 个工具走完 begin → question → answer → settle → archive，并断言 4 类会话事件。
  - `stress-verify.mjs`：重复 begin、未知会话、跨会话隔离、并发回答、settle 后迟到写入、重复 archive。
  - `verify:skill`：`.dsh/skills` 镜像与源 skill 一致。
- 组合验证：`dsh plugin --profile headless add .` 后 `dsh --profile headless --dump-config | grep "id: grill-me"`。
- 真实 e2e：`dsh --profile headless "用户想做一个'智能体系统'。先用 grill-me 拷打边界，再输出明确需求"`，核对 `.grill-me/` 落盘与会话事件。