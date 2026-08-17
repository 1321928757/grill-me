# AGENTS.md

grill-me 是一个 DeepSeek Harness (DSH) 插件：当用户 query 边界模糊时，agent 按设计树轮次拷打用户，直到边界明确再执行。

## 角色边界（不可破坏）

- **人类（产品负责人）**：只负责审查与沟通。通过 issue、PR 评论或本会话表达意图；不直接修改任何代码或文档。
- **Agent（实现者）**：拥有全部文件编辑权。读本文件和 `skills/dsh-grill-dev/SKILL.md` 后再动手；不要求人类代替 agent 查事实。

## 工作流

1. 每个 PR 只做一件事，分支名 `codex/<slug>`。
2. 实现前先读目标接口和现有测试；实现后运行 `pnpm typecheck && pnpm build && pnpm verify`。
3. 代码与文档（README/JSDoc/skill 镜像）必须在同一 PR 更新。
4. 开 PR 前先按 grilling 协议自审：设计决策是否显式、是否还有未证假设。
5. 人类只在 PR 上评论/approve；agent 在该 PR 内应用反馈，不新开分支。
6. CI 全绿后 squash merge；打 `v*.*.*` tag 触发发布。

## 插件协议

- 拷打唯一入口是 `/grill-me` 命令（`/grill-me <query>` 或裸 `/grill-me` 拷打最近一条用户请求）；无自动触发，/grill-me 触发后强制走完设计树直到 settle。
- 模糊 query 进入设计树：每个决策是树节点，答案会解锁后续决策。
- 每轮只问 frontier（前置已决的决策），一次问完，每题带推荐答案。
- 事实查询是 agent 的职责，不能反问用户；只有决策属于用户。
- frontier 为空且用户确认后，才输出边界规格并继续执行。

## 工程约束

- ESM only、严格 TypeScript、`.ts` 相对导入。
- 所有注册走 `ctx.effect()` / `ctx.on()`，disposer 必须可清理。
- 模型可见内容必须能由会话日志重建。
- `grill_*` 工具以 `<workspace>/.grill-me/` 为持久化真相源。
- 测试描述行为，不描述“正确性”。