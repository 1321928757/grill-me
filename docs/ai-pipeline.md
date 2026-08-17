# grill-me AI 流水线

本仓库的开发遵循“人类只审查、agent 只实现”的流水线。

## 角色

- 人类（产品负责人）：只在 GitHub issue 写意图、在 PR 上评论和 approve。不直接修改代码与文档。
- 实现 agent（Codex/DSH）：拥有全部文件编辑权；每次一个 `codex/<slug>` 分支；开 PR 前跑 `pnpm typecheck && pnpm build && pnpm verify`。
- AI 审查 agent：合并前按 `AGENTS.md` 与 `skills/dsh-grill-dev/SKILL.md` 自审，先改掉自己的问题再交给人审。
- CI/CD：`ci.yml` 在 PR 上重放检查；`publish.yml` 在 `v*.*.*` tag 时发布 npm。

## 闭环

```text
人类写 issue（意图）→ agent 读 AGENTS.md + skill → codex/ 分支实现
→ pnpm typecheck/build/verify → AI 自审 → 开 PR → CI 全绿
→ 人类只评论/approve → agent 在 PR 内修改 → squash merge → tag 发布
```

## 人类审查清单

- [ ] 改动是否只做一件事，PR 描述是否说明设计决策
- [ ] 代码与文档（README/JSDoc/skill 镜像）是否在同一 PR
- [ ] `pnpm typecheck`、`pnpm build`、`pnpm verify` 是否通过
- [ ] grill 协议是否遵守：是否替用户假设答案、是否跳过 frontier
- [ ] 会话持久化与归档是否可复核

## 外部前置条件

- GitHub CLI：`winget install --id GitHub.cli`，然后 `gh auth login`。
- 一键建仓与开 PR：`powershell -File scripts/setup-github.ps1`。
- 真实 e2e：安装 DSH CLI 并配置 `DEEPSEEK_API_KEY` 后运行 `powershell -File scripts/e2e.ps1`。