# grill-me 实现说明

> 本文描述 dsh-grill-me 插件自身如何实现，供维护与二次开发使用；它不是通用 DSH 插件教程。

## 项目定位

本项目只实现 grill-me：当用户 query 边界模糊时，agent 用设计树 frontier 轮次拷打用户，直到边界明确并固化，才继续执行。插件为 host-only，不含浏览器 client 面。

## 代码布局

```
src/
├── index.ts          # 插件入口：name / inject / Config / apply
├── tools.ts          # 6 个 grill_* 工具的 defineTool 注册
├── state.ts          # 设计树纯规则 + session.json 持久化 + 会话锁
├── types.ts          # GrillDecision / GrillSession / GrillStatus
├── event-types.ts    # SessionEventMap 合并（零 import）
└── events.ts         # grill-me/* 事件发射（边界转换 + 降级）
scripts/
├── verify.mjs            # 打包契约 + 纯规则 + 落盘/归档
├── lifecycle-verify.mjs  # 工具生命周期 + 事件断言
└── stress-verify.mjs     # 并发与隔离矩阵
```

## 插件契约

- `name`：`grill-me`；`inject`：`tools`、`systemPrompt`。
- `Config`：
  - `stateDir`（默认 `.grill-me`）：工作区下的状态目录名；
  - `promptSectionOrder`（默认 `118`）：system prompt 段顺序。
- `cordis.patch.yml` 的 `name` 必须等于 npm 包名 `@nanmicoder/dsh-grill-me`，否则 profile 加载失败。

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
| `grill_answer` | 记录答案并冻结决策 | 已答决策重复回答拒绝 |
| `grill_frontier` | 返回树、frontier、settled、boundary | 未知会话拒绝 |
| `grill_settle` | frontier 空且 boundary 非空时固化 | 未满足条件拒绝 |
| `grill_archive` | 归档目录，历史完整保留 | 已归档会话重复归档拒绝 |

## 持久化

- 状态真相源：`<workspace>/<stateDir>/<sessionId>/session.json`。
- 新建：`flag: 'wx'` no-clobber；更新：同目录临时文件 + rename 原子发布。
- 归档：rename 到 `<stateRoot>/archive/`，live 扫描不可见。
- 同一会话的读-改-写由进程内 promise 链锁串行化；多进程不协调。

## 事件

- `grill-me/session-created`、`decision-answered`、`session-settled`、`session-archived`。
- `event-types.ts` 只做 `declare module` 合并，零运行时 import。
- 发射时 `session.append` 是泛型方法，跨边界做受控类型转换；事件 append 失败只降级警告，磁盘状态不受影响。

## 验证

- `pnpm verify` 聚合四段：
  - `verify.mjs`：打包契约、frontier 纯规则、session.json 往返/归档；
  - `lifecycle-verify.mjs`：驱动编译后工具走 begin → question → answer → settle → archive，断言 4 类事件；
  - `stress-verify.mjs`：重复 begin、未知会话、跨会话隔离、并发回答、迟到写入、重复 archive；
  - `verify:skill`：`.dsh/skills` 镜像与源一致。
- 组合：`dsh plugin --profile headless add .` + `dsh --profile headless --dump-config | grep "id: grill-me"`。
- 真实 e2e：需要 DSH CLI + `DEEPSEEK_API_KEY`，由 `scripts/e2e.ps1` 或 `Real E2E` 工作流执行。

## 已知约定

- 一个 query 对应一个会话（id = sanitizeKey(query)），同名 query 需先归档。
- 不记录轮次计数器：轮次是模型按协议驱动的行为，工具只维护设计树状态。
- 磁盘状态是执行真相；会话事件用于审计/重放，两者职责分离。